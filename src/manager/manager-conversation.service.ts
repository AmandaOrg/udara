import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { ChunkedMessengerService } from "../whatsapp/chunked-messenger.service";
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
    private readonly whatsapp: WhatsappService,
    private readonly chunkedMessenger: ChunkedMessengerService,
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

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "The managers have received your request. We'll get back to you shortly — and note that any change still can't take effect for at least a few days from today, regardless of how it's framed.",
      user.id,
    );

    return request;
  }

  /**
   * The delayed initial reply itself — called by ManagerScheduler once
   * initialReplyDueAt has passed. initialReplySentAt is only stamped *after*
   * the send succeeds — if WhatsApp delivery fails, this throws and the
   * request stays eligible for findDueInitialReplies, so ManagerScheduler
   * naturally retries on its next tick instead of losing the notification
   * silently.
   */
  async sendInitialReply(requestId: string): Promise<void> {
    const request = await this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
    });

    const message = await this.generateInitialReplyText(user, request);

    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      message,
      user.id,
    );
    await this.prisma.settingsChangeRequest.update({
      where: { id: requestId },
      data: { initialReplySentAt: new Date() },
    });
  }

  private async generateInitialReplyText(
    user: User,
    request: SettingsChangeRequest,
  ): Promise<string> {
    const eligibleAtText = request.eligibleAt.toDateString();
    const goalContext = user.statedGoal
      ? `On ${user.statedGoalSetAt ? user.statedGoalSetAt.toDateString() : "an earlier date"}, this user told Kedu their goal was: "${user.statedGoal}".`
      : "This user has not stated a goal yet — don't invent one.";

    const contextMessage: LlmMessage = {
      role: "system",
      content: [
        `Request type: ${request.type}`,
        `Requested change: "${request.requestedChange}"`,
        request.reason
          ? `Reason given: "${request.reason}"`
          : "No reason given.",
        goalContext,
        `This request becomes eligible for a decision on ${eligibleAtText}, not before — this date is fixed and non-negotiable, state it plainly.`,
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
        "Your account has returned to normal — no window or override-fee restrictions apply anymore.",
      );
    }
    await this.whatsapp.sendText(user.whatsappNumber, lines.join(" "), user.id);

    return updated;
  }

  /** Requests due for their initial reply but not yet sent — used by ManagerScheduler. */
  async findDueInitialReplies() {
    return this.prisma.settingsChangeRequest.findMany({
      where: {
        initialReplyDueAt: { lte: new Date() },
        initialReplySentAt: null,
        status: SettingsChangeStatus.PENDING,
      },
    });
  }
}
