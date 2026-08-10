import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { ManagerService } from "./manager.service";
import { SettingsChangeStatus, SettingsChangeType } from "@prisma/client";

/**
 * The conversation-layer half of "the managers" (PRD §7) — everything
 * ManagerService itself deliberately does NOT do: the persona reply, the
 * deliberate delay, and applying the effect of an approved decision.
 * ManagerService's hard eligibleAt gate is never touched from here.
 *
 * AI is deferred (Phase 3/4, deliberately): the actual conversational reply
 * is a canned template rather than a generated one, but it still does the
 * one thing that matters procedurally — quotes the user's own statedGoal
 * back at them (PRD §7: "the callback should quote the user's own stated
 * goal and progress from onboarding") — and the tone is written to read as
 * more procedural/less warm than Kedu's own replies, even though nothing
 * here is a hallucinated persona voice.
 */
@Injectable()
export class ManagerConversationService {
  private readonly logger = new Logger(ManagerConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: ManagerService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
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
   * initialReplyDueAt has passed. Quotes statedGoal when it exists; the
   * eligibleAt date is stated plainly either way, since that's the one thing
   * that must never be soft-pedaled. initialReplySentAt is only stamped
   * *after* the send succeeds — if WhatsApp delivery fails, this throws and
   * the request stays eligible for findDueInitialReplies, so
   * ManagerScheduler naturally retries on its next tick instead of losing
   * the notification silently.
   */
  async sendInitialReply(requestId: string): Promise<void> {
    const request = await this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
    });

    const eligibleAtText = request.eligibleAt.toDateString();
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

    await this.whatsapp.sendText(user.whatsappNumber, lines.join(" "), user.id);
    await this.prisma.settingsChangeRequest.update({
      where: { id: requestId },
      data: { initialReplySentAt: new Date() },
    });
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
