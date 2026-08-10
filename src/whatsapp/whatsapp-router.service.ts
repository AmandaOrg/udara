import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import {
  OnboardingService,
  isPreAccountStage,
} from "../onboarding/onboarding.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "./transfer-confirmation.service";
import { ManagerConversationService } from "../manager/manager-conversation.service";
import { KeduChatService } from "./kedu-chat.service";
import {
  parseManagerCommand,
  parseTransferCommand,
  isSpendSummaryQuery,
} from "./parsers/text-command.parser";
import { User, WhatsappMessage, WhatsappMessageType } from "@prisma/client";

const STOPGAP_HELP_TEXT =
  "quick reference — i can also just chat, but these always work:\n" +
  '  "send <amount> to <10-digit account> <6-digit bank code>"\n' +
  '  "summary" — this week\'s spending\n' +
  '  "manager <WINDOW_HOURS|OVERRIDE_FEES|EXIT_RESTRICTIONS|OTHER> <why>"';

/**
 * The top-level inbound decision tree (PRD §5: webhook-in -> window check ->
 * allowance check -> ... -> response-out).
 *
 * Free-text transfer/settings-change/summary intent is still a small set of
 * structured stopgap commands (parsers/text-command.parser.ts), not real NLP
 * classification — deliberately honest about that; nothing downstream
 * depends on it changing. Everything else (general conversation, and the
 * full onboarding script) now goes through the real AI layer.
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
    private readonly keduChat: KeduChatService,
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
   * Dispatches by button-id namespace: confirm_transfer/cancel_transfer to
   * TransferConfirmationService; during onboarding's STRUCTURED_QUESTIONS
   * stage, everything else goes to OnboardingService's list-reply handler.
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

    if (isPreAccountStage(user.onboardingStage)) {
      await this.onboarding.handleInboundButton(user, payload);
      return;
    }

    this.logger.debug(
      `Button reply "${payload}" from ${message.fromNumber} — not routed`,
    );
    await this.whatsapp.sendText(
      message.fromNumber,
      "Got it — I'm not able to act on that yet, this part of Kedu isn't wired up.",
      user.id,
    );
  }

  /**
   * Pre-account-stage users (still in the onboarding script) go entirely to
   * OnboardingService. Everyone else gets the structured stopgap commands
   * first (transfer/manager/summary), falling through to real Kedu-persona
   * chat for anything else.
   */
  private async handleText(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const text = message.textBody ?? "";

    if (isPreAccountStage(user.onboardingStage)) {
      await this.onboarding.handleInboundText(user, text);
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

    if (/^help$|^menu$|^commands$/i.test(text.trim())) {
      await this.whatsapp.sendText(
        message.fromNumber,
        STOPGAP_HELP_TEXT,
        user.id,
      );
      return;
    }

    await this.keduChat.handleMessage(user, text);
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
