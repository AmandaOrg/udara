import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
} from "@nestjs/common";
import { AppMessage, User } from "@prisma/client";
import type { AppPrincipal } from "../../app-auth/session.service";
import {
  AppInbound,
  AppMessageService,
} from "../../messaging/app-message.service";
import { AppMessageNotifier } from "../../messaging/app-message.notifier";
import { ChannelMessenger } from "../../messaging/channel-messenger";
import { runInChannel } from "../../messaging/channel-context";
import { ConversationRouterService } from "../../conversation/conversation-router.service";
import { TurnService } from "../../conversation/turn.service";
import { OnboardingService } from "../../onboarding/onboarding.service";
import { InboundRateLimitService } from "../../whatsapp/inbound-rate-limit.service";
import type { SensitiveFields } from "../../whatsapp/whatsapp-message.service";
import { AppMessageView, toView } from "./app-message.view";
import type { KycFormDto, PinFormDto } from "./chat.dto";

/** A poll re-reads the database this often even with no wake-up, for rows another replica wrote. */
const POLL_RECHECK_MS = 2_000;
/** How long shutdown waits for turns already running. */
const DRAIN_ON_SHUTDOWN_MS = 20_000;

const TURN_FAILED =
  "sorry, something went wrong on my side. could you try that again?";

export interface Accepted {
  id: string;
  seq: string;
  status: string;
}

export interface MessagePage {
  messages: AppMessageView[];
  cursor: string | null;
  processing: boolean;
}

/**
 * The app's chat: takes what the user sent, answers 202, and handles it in the
 * background as a turn on the app channel, with replies written as AppMessage
 * rows for the app to poll.
 *
 * Handling is not awaited by the request because a turn can take as long as an
 * LLM call plus a bank call, which is longer than a phone on a Lagos mobile
 * network should hold a request open. The inbound row records whether it
 * finished.
 */
@Injectable()
export class AppConversationService implements OnApplicationShutdown {
  private readonly logger = new Logger(AppConversationService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly store: AppMessageService,
    private readonly notifier: AppMessageNotifier,
    private readonly conversation: ConversationRouterService,
    private readonly onboarding: OnboardingService,
    private readonly turns: TurnService,
    private readonly rateLimit: InboundRateLimitService,
    private readonly messenger: ChannelMessenger,
  ) {}

  sendText(
    principal: AppPrincipal,
    clientMessageId: string,
    text: string,
  ): Promise<Accepted> {
    return this.accept(
      principal,
      { clientMessageId, kind: "TEXT", body: text },
      // The stored, scrubbed text is what the conversation sees, exactly as
      // on WhatsApp: a PIN typed into the chat never reaches the model.
      (user, row) => this.conversation.handleText(user, row.body ?? ""),
    );
  }

  async sendChoice(
    principal: AppPrincipal,
    clientMessageId: string,
    reply: { messageId: string; choiceId: string },
  ): Promise<Accepted> {
    const title = await this.store.findOfferedChoice(
      principal.userId,
      reply.messageId,
      reply.choiceId,
    );
    // One answer for "not yours", "no such message" and "not offered", so a
    // probe learns nothing about other users' messages.
    if (title === null) throw new NotFoundException({ error: "not_found" });

    return this.accept(
      principal,
      {
        clientMessageId,
        kind: "CHOICE",
        body: title,
        payload: { replyTo: reply.messageId, choiceId: reply.choiceId },
      },
      (user) => this.conversation.handleChoice(user, reply.choiceId),
    );
  }

  start(principal: AppPrincipal, clientMessageId: string): Promise<Accepted> {
    return this.accept(principal, { clientMessageId, kind: "START" }, (user) =>
      this.onboarding.startConversation(user),
    );
  }

  /**
   * The same `form` / `sensitive` split the WhatsApp Flow path produces: the
   * ID number and date of birth only ever in `sensitive`, in memory, handed to
   * the background turn by closure. The stored row says only which form came.
   */
  submitKyc(principal: AppPrincipal, dto: KycFormDto): Promise<Accepted> {
    const form = {
      flow_token: dto.token,
      first_name: dto.firstName,
      middle_name: dto.middleName ?? "",
      last_name: dto.lastName,
      id_type: dto.idType,
      email: dto.email,
    };
    const sensitive: SensitiveFields = {
      id_number: dto.idNumber,
      date_of_birth: dto.dateOfBirth,
    };
    return this.accept(
      principal,
      {
        clientMessageId: dto.clientMessageId,
        kind: "FORM_SUBMISSION",
        payload: { form: "KYC" },
      },
      (user) => this.conversation.handleKycForm(user, form, sensitive),
    );
  }

  submitPin(principal: AppPrincipal, dto: PinFormDto): Promise<Accepted> {
    const sensitive: SensitiveFields = { pin: dto.pin };
    if (dto.pinConfirm !== undefined) sensitive.pin_confirm = dto.pinConfirm;
    if (dto.otp !== undefined) sensitive.otp = dto.otp;
    return this.accept(
      principal,
      {
        clientMessageId: dto.clientMessageId,
        kind: "FORM_SUBMISSION",
        payload: { form: "PIN" },
      },
      (user) =>
        this.conversation.handlePinForm(
          user,
          { flow_token: dto.token },
          sensitive,
        ),
    );
  }

  /**
   * Messages after `after`, or the latest page. With `waitMs`, holds the
   * request until there is something new, or until whether Udara is still
   * working changes (a turn that ends without a reply), or the time runs out.
   */
  async list(
    principal: AppPrincipal,
    after: bigint | undefined,
    waitMs: number,
  ): Promise<MessagePage> {
    const userId = principal.userId;
    const deadline = Date.now() + waitMs;
    const processingAtStart = await this.store.isProcessing(userId);
    let processing = processingAtStart;

    for (;;) {
      const rows = await this.store.list(userId, after);
      const remaining = deadline - Date.now();
      if (
        rows.length > 0 ||
        processing !== processingAtStart ||
        remaining <= 0
      ) {
        return {
          messages: rows.map(toView),
          cursor:
            rows.length > 0
              ? rows[rows.length - 1].seq.toString()
              : (after?.toString() ?? null),
          processing,
        };
      }
      await this.notifier.wait(userId, Math.min(POLL_RECHECK_MS, remaining));
      processing = await this.store.isProcessing(userId);
    }
  }

  /** Lets turns already running finish before the process exits (a deploy). */
  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, DRAIN_ON_SHUTDOWN_MS)),
    ]);
  }

  /** Resolves once every turn started so far has finished. For tests. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async accept(
    principal: AppPrincipal,
    inbound: AppInbound,
    handle: (user: User, row: AppMessage) => Promise<void>,
  ): Promise<Accepted> {
    const { row, isNew } = await this.store.recordInbound(
      principal.userId,
      inbound,
    );
    if (!isNew) return accepted(row);

    // Counts this row too, like the WhatsApp path.
    const rate = await this.rateLimit.check(principal.userId);
    if (rate.limited) {
      await this.store.markProcessed(row.id, "FAILED");
      throw new HttpException(
        { error: "rate_limited" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const task = this.process(principal, row, handle);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return accepted(row);
  }

  private async process(
    principal: AppPrincipal,
    row: AppMessage,
    handle: (user: User, row: AppMessage) => Promise<void>,
  ): Promise<void> {
    await runInChannel(
      { channel: "app", deviceId: principal.deviceId },
      async () => {
        let user: User | null = null;
        try {
          await this.turns.run(principal.userId, "app", (current) => {
            user = current;
            return handle(current, row);
          });
          await this.store.markProcessed(row.id, "PROCESSED");
        } catch (err) {
          this.logger.error(
            `app message ${row.id} (${row.kind}) failed: ${String(err)}`,
          );
          await this.store
            .markProcessed(row.id, "FAILED")
            .catch(() => undefined);
          // WhatsApp stays silent on a failed turn; in the app the user is
          // watching a "working on it" indicator that would just stop.
          if (user) {
            await this.messenger
              .sendText(user, TURN_FAILED)
              .catch(() => undefined);
          }
        }
      },
    );
  }
}

function accepted(row: AppMessage): Accepted {
  return {
    id: row.id,
    seq: row.seq.toString(),
    status: String(row.status ?? "").toLowerCase(),
  };
}
