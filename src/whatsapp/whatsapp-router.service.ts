import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import { OnboardingService } from "../onboarding/onboarding.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "./transfer-confirmation.service";
import { ManagerConversationService } from "../manager/manager-conversation.service";
import {
  parseManagerCommand,
  parseTransferCommand,
  isSpendSummaryQuery,
} from "./parsers/text-command.parser";
import {
  OnboardingStage,
  User,
  WhatsappMessage,
  WhatsappMessageType,
} from "@prisma/client";

const STOPGAP_HELP_TEXT =
  "Kedu's full conversation engine isn't wired up yet. For now, try:\n" +
  '  "send <amount> to <10-digit account> <6-digit bank code>"\n' +
  '  "summary" — this week\'s spending\n' +
  '  "manager <WINDOW_HOURS|OVERRIDE_FEES|EXIT_RESTRICTIONS|OTHER> <why>"';

/**
 * The top-level inbound decision tree (PRD §5: webhook-in -> window check ->
 * allowance check -> ... -> response-out). Free-text intent classification
 * (AI layer, Phase 3, deliberately deferred) is replaced by a small set of
 * structured text commands (parsers/text-command.parser.ts) — deliberately
 * honest about being a stopgap, not real NLP. Onboarding's structured
 * questions still need Phase 4, also deferred — the onboarding branch below
 * remains a placeholder for that specifically.
 */
@Injectable()
export class WhatsappRouterService {
  private readonly logger = new Logger(WhatsappRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly onboarding: OnboardingService,
    private readonly spendSummary: SpendSummaryService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly managerConversation: ManagerConversationService,
  ) {}

  async route(message: WhatsappMessage): Promise<void> {
    const user = await this.findOrCreateUser(message.fromNumber);

    switch (message.type) {
      case WhatsappMessageType.AUDIO:
        return this.handleAudio(user, message);
      case WhatsappMessageType.BUTTON_REPLY:
      case WhatsappMessageType.LIST_REPLY:
        return this.handleButtonReply(user, message);
      case WhatsappMessageType.TEXT:
        return this.handleText(user, message);
      case WhatsappMessageType.IMAGE:
      case WhatsappMessageType.DOCUMENT:
      case WhatsappMessageType.LOCATION:
        return this.handleUnsupportedMedia(user, message);
      case WhatsappMessageType.UNKNOWN:
      default:
        this.logger.warn(
          `Unhandled/unrecognized message type from ${message.fromNumber}`,
        );
        await this.whatsapp.sendText(
          message.fromNumber,
          "Sorry, I couldn't understand that message.",
          user.id,
        );
    }
  }

  /** Looks up the user by WhatsApp number, creating a fresh DISCOVERY-stage row on first contact. */
  private async findOrCreateUser(whatsappNumber: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({
      where: { whatsappNumber },
    });
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { lastInboundMessageAt: new Date() },
      });
    }
    return this.prisma.user.create({
      data: { whatsappNumber, lastInboundMessageAt: new Date() },
    });
  }

  /**
   * v0 scope decision (see build-out plan): audio stays fully stubbed,
   * including during onboarding, despite the PRD's voice-note-first design.
   * The mediaId is already persisted on the WhatsappMessage row by
   * WhatsappMessageService — downloadMedia()/transcription is a fast-follow,
   * not built now — so this is a real, honest reply, not a lie.
   */
  private async handleAudio(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    await this.whatsapp.sendText(
      message.fromNumber,
      "I can't listen to voice notes yet — could you type that instead?",
      user.id,
    );
  }

  /**
   * Dispatches by button-id namespace. The confirm_transfer / cancel_transfer
   * prefixes (Phase 8) are real. Onboarding quick-reply buttons still need
   * Phase 4's structured-question handling (deferred) — anything else falls
   * through to a placeholder.
   */
  private async handleButtonReply(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const payload = message.buttonPayload ?? "";

    if (payload.startsWith(CONFIRM_BUTTON_PREFIX)) {
      const transactionId = payload.slice(CONFIRM_BUTTON_PREFIX.length);
      await this.transferConfirmation.confirmTransfer(transactionId);
      return;
    }
    if (payload.startsWith(CANCEL_BUTTON_PREFIX)) {
      const transactionId = payload.slice(CANCEL_BUTTON_PREFIX.length);
      await this.transferConfirmation.cancelTransfer(transactionId);
      return;
    }

    this.logger.debug(
      `Button reply "${payload}" from ${message.fromNumber} — not yet routed`,
    );
    await this.whatsapp.sendText(
      message.fromNumber,
      "Got it — I'm not able to act on that yet, this part of Kedu isn't wired up.",
      user.id,
    );
  }

  /**
   * Onboarding-incomplete users: message history is captured for real (so
   * nothing is lost once the AI layer lands), but the conversational reply
   * is a placeholder — OnboardingService.buildPrompt/extractStructuredField
   * are TODOs (Phase 3/4, deliberately deferred).
   * Onboarding-complete users: dispatched through the structured-command
   * stopgap (see module docblock) — transfer / manager / spend-summary — or
   * the help text if nothing matches.
   */
  private async handleText(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const text = message.textBody ?? "";

    if (user.onboardingStage !== OnboardingStage.COMPLETE) {
      const session = await this.onboarding.getOrStartSession(user.id);
      await this.onboarding.appendMessage(session.id, "user", text);
      await this.whatsapp.sendText(
        message.fromNumber,
        "Thanks — I've got that noted. Kedu's onboarding conversation isn't fully wired up yet, but nothing you say here is lost.",
        user.id,
      );
      return;
    }

    const transferCommand = parseTransferCommand(text);
    if (transferCommand) {
      await this.transferConfirmation.initiateTransfer({
        userId: user.id,
        ...transferCommand,
      });
      return;
    }

    const managerCommand = parseManagerCommand(text);
    if (managerCommand) {
      await this.managerConversation.fileChangeRequest({
        userId: user.id,
        ...managerCommand,
      });
      return;
    }

    if (isSpendSummaryQuery(text)) {
      const summary = await this.spendSummary.getWeeklySummary(user.id);
      await this.whatsapp.sendText(
        message.fromNumber,
        this.spendSummary.formatAsText(summary),
        user.id,
      );
      return;
    }

    await this.whatsapp.sendText(
      message.fromNumber,
      STOPGAP_HELP_TEXT,
      user.id,
    );
  }

  private async handleUnsupportedMedia(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    await this.whatsapp.sendText(
      message.fromNumber,
      "I can't do anything with that kind of message yet — could you send it as text?",
      user.id,
    );
  }
}
