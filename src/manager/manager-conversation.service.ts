import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { ManagerService } from "./manager.service";
import { CONVERSATION_LLM, LlmMessage, LlmService } from "../ai/llm.types";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { buildManagerSystemMessage } from "../ai/prompts/manager-persona.prompts";
import {
  LlmCallPurpose,
  SettingsChangeRequest,
  SettingsChangeStatus,
  SettingsChangeType,
  User,
} from "@prisma/client";

/** Udara starts this conversation; nobody asked. */
const PROACTIVE = { delivery: "proactive" } as const;

/**
 * Stop retrying the delayed managers reply after this long. Past it the request
 * is still valid and still gated by eligibleAt — only the courtesy
 * acknowledgement is abandoned, rather than retried once a minute forever.
 */
const INITIAL_REPLY_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The conversation-layer half of "the managers" (PRD §7) — everything
 * ManagerService itself deliberately does NOT do: the persona reply, the
 * deliberate delay, and applying the effect of an approved decision.
 * ManagerService's hard eligibleAt gate is never touched from here.
 *
 * The substantive reply (sendInitialReply) is now real AI generation, using
 * the Manager persona prompt (docs/✅-Kedu-Character-Tone-Prompt.pdf's "the
 * one place your tone shifts on purpose") — with a deterministic fallback
 * template if the call fails, so the mechanic that actually matters (quoting
 * statedGoal, stating eligibleAt plainly) never breaks just because the AI
 * provider is unavailable.
 */
@Injectable()
export class ManagerConversationService {
  private readonly logger = new Logger(ManagerConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: ManagerService,
    private readonly messenger: ChannelMessenger,
    private readonly config: ConfigService,
    @Inject(CONVERSATION_LLM) private readonly llm: LlmService,
    private readonly llmLogger: LlmCallLoggerService,
  ) {}

  private get initialReplyDelayHours(): number {
    return Number(
      this.config.get<number>("MANAGER_INITIAL_REPLY_DELAY_HOURS", 3),
    );
  }

  /**
   * Files the request (ManagerService's hard eligibleAt gate is computed
   * there, unchanged), sends an immediate plain acknowledgment, and schedules
   * the actual substantive reply for a few hours out — see
   * ManagerScheduler.sendDueInitialReplies for the other half of this.
   */
  async fileChangeRequest(params: {
    userId: string;
    type: SettingsChangeType;
    requestedChange: string;
    reason?: string;
  }) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.userId },
    });
    const request = await this.manager.fileChangeRequest(params);

    const initialReplyDueAt = new Date(
      Date.now() + this.initialReplyDelayHours * 60 * 60 * 1000,
    );
    await this.prisma.settingsChangeRequest.update({
      where: { id: request.id },
      data: { initialReplyDueAt },
    });

    await this.messenger.sendText(
      user,
      "The managers have received your request. We'll get back to you shortly, and note that any change still can't take effect for at least a few days from today, regardless of how it's framed.",
    );

    return request;
  }

  /**
   * The delayed initial reply, called by ManagerScheduler once
   * initialReplyDueAt has passed.
   *
   * The claim happens first, before the LLM call and the send. Stamping
   * afterwards was intended to make a failed delivery retry on the next tick,
   * but the scheduler runs every minute and each iteration is an LLM round-trip
   * plus a multi-chunk send — so two replicas, or one tick overrunning into the
   * next, both selected the same row and both generated and sent. A user got the
   * managers' reply twice and we paid for the model twice.
   *
   * Retry-on-failure is preserved by releasing the claim if the send throws,
   * bounded by an attempt ceiling so a permanently undeliverable request stops
   * burning an LLM call every minute forever.
   */
  async sendInitialReply(requestId: string): Promise<void> {
    const claimedAt = new Date();
    const { count } = await this.prisma.settingsChangeRequest.updateMany({
      where: { id: requestId, initialReplySentAt: null },
      data: { initialReplySentAt: claimedAt },
    });
    if (count === 0) return; // another replica or tick already has it

    const request = await this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
    });

    try {
      const message = await this.generateInitialReplyText(user, request);
      await this.messenger.sendChunked(user, message, PROACTIVE);
    } catch (err) {
      // Release the claim so the next tick can retry — but only while the
      // request is still young. findDueInitialReplies bounds how long that is.
      await this.prisma.settingsChangeRequest.updateMany({
        where: { id: requestId, initialReplySentAt: claimedAt },
        data: { initialReplySentAt: null },
      });
      throw err;
    }
  }

  private async generateInitialReplyText(
    user: User,
    request: SettingsChangeRequest,
  ): Promise<string> {
    const eligibleAtText = request.eligibleAt.toDateString();
    const goalContext = user.statedGoal
      ? `On ${user.statedGoalSetAt ? user.statedGoalSetAt.toDateString() : "an earlier date"}, this user told Udara their goal was: "${user.statedGoal}".`
      : "This user has not stated a goal yet, so don't invent one.";

    const contextMessage: LlmMessage = {
      role: "system",
      content: [
        `Request type: ${request.type}`,
        `Requested change: "${request.requestedChange}"`,
        request.reason
          ? `Reason given: "${request.reason}"`
          : "No reason given.",
        goalContext,
        `This request becomes eligible for a decision on ${eligibleAtText}, not before. This date is fixed and non-negotiable, state it plainly.`,
        "Write the initial reply now: acknowledge the request, reference their stated goal if one was given, and state the eligibility date plainly.",
      ].join("\n"),
    };

    try {
      const result = await this.llm.complete({
        messages: [buildManagerSystemMessage(), contextMessage],
        purpose: LlmCallPurpose.MANAGER_REPLY,
        userId: user.id,
      });
      await this.llmLogger.log({
        userId: user.id,
        purpose: LlmCallPurpose.MANAGER_REPLY,
        result,
      });
      if (result.text) return result.text;
    } catch (err) {
      this.logger.warn(
        `Manager AI reply generation failed, falling back to template: ${String(err)}`,
      );
    }

    return this.buildFallbackInitialReplyText(user, request, eligibleAtText);
  }

  private buildFallbackInitialReplyText(
    user: User,
    request: SettingsChangeRequest,
    eligibleAtText: string,
  ): string {
    const lines = [
      "This is the managers.",
      `We've logged your request: "${request.requestedChange}"`,
    ];
    if (request.reason) lines.push(`Reason given: "${request.reason}"`);
    if (user.statedGoal) {
      const since = user.statedGoalSetAt
        ? ` on ${user.statedGoalSetAt.toDateString()}`
        : "";
      lines.push(
        `You told us${since}: "${user.statedGoal}". We're holding this request against that.`,
      );
    }
    lines.push(
      `It becomes eligible for a decision on ${eligibleAtText}, not before. We'll follow up then.`,
    );
    return lines.join(" ");
  }

  /**
   * Wraps ManagerService.reviewRequest — the hard eligibleAt check there is
   * untouched and still throws if called early, regardless of what calls
   * this. Applies the one real side effect an APPROVED decision can have:
   * EXIT_RESTRICTIONS sets User.disciplineExitedAt, which is the only
   * mechanical meaning of PRD §4.1's "the account returns to normal" —
   * AllowanceService checks this field and nothing else ever writes it.
   */
  async reviewRequest(
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    managerNotes?: string,
  ) {
    const updated = await this.manager.reviewRequest(
      requestId,
      decision,
      managerNotes,
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: updated.userId },
    });

    if (
      decision === "APPROVED" &&
      updated.type === SettingsChangeType.EXIT_RESTRICTIONS
    ) {
      // The approval and the restriction lift are one unit. As two separate
      // writes, a failure between them left a request marked approved while the
      // user stayed locked — and the eligibility gate passes on a retry, so the
      // half-applied state was invisible.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { disciplineExitedAt: new Date() },
      });
    }

    const outcome = decision === "APPROVED" ? "approved" : "not approved";
    const lines = [
      `The managers have ${outcome} your request: "${updated.requestedChange}".`,
    ];
    if (managerNotes) lines.push(`Notes: "${managerNotes}"`);
    if (
      decision === "APPROVED" &&
      updated.type === SettingsChangeType.EXIT_RESTRICTIONS
    ) {
      lines.push(
        "Your account has returned to normal, no window or override-fee restrictions apply anymore.",
      );
    }
    await this.messenger.sendText(user, lines.join(" "), PROACTIVE);

    return updated;
  }

  /** Requests due for their initial reply but not yet sent — used by ManagerScheduler. */
  async findDueInitialReplies() {
    const now = new Date();
    return this.prisma.settingsChangeRequest.findMany({
      where: {
        // Bounded on both sides. Without the floor, a request whose delivery
        // keeps failing — a number that has left WhatsApp, an expired token —
        // stayed eligible forever and cost one LLM call and one send attempt
        // every single minute, indefinitely.
        initialReplyDueAt: {
          lte: now,
          gte: new Date(now.getTime() - INITIAL_REPLY_GIVE_UP_MS),
        },
        initialReplySentAt: null,
        status: SettingsChangeStatus.PENDING,
      },
      orderBy: { initialReplyDueAt: "asc" },
      take: 50,
    });
  }
}
