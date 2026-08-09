import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import { OnboardingService } from "../onboarding/onboarding.service";
import {
  OnboardingStage,
  User,
  WhatsappMessage,
  WhatsappMessageType,
} from "@prisma/client";

/**
 * The top-level inbound decision tree (PRD §5: webhook-in -> window check ->
 * allowance check -> ... -> response-out). This is the Phase 2 skeleton:
 * lookup/create-user and dispatch-by-message-type are fully wired, but the
 * branches that need free-text intent classification or generated
 * conversational replies (AI layer, Phase 3; onboarding prompts, Phase 4) are
 * deliberately left as clearly-marked placeholders — see each handler below.
 * Phase 8 replaces those placeholders with TransferConfirmationService /
 * ManagerConversationService dispatch once those exist.
 */
@Injectable()
export class WhatsappRouterService {
  private readonly logger = new Logger(WhatsappRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly onboarding: OnboardingService,
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
   * TODO (Phase 8): dispatch by button-id namespace
   * (`confirm_transfer:*`/`cancel_transfer:*` -> TransferConfirmationService,
   * onboarding quick-replies -> OnboardingService). Not wired yet since
   * TransferConfirmationService doesn't exist until Phase 8 and
   * OnboardingService's structured-question handling needs the AI layer
   * (Phase 3/4, deliberately deferred).
   */
  private async handleButtonReply(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    this.logger.debug(
      `Button reply "${message.buttonPayload}" from ${message.fromNumber} — not yet routed`,
    );
    await this.whatsapp.sendText(
      message.fromNumber,
      "Got it — I'm not able to act on that yet, this part of Kedu isn't wired up.",
      user.id,
    );
  }

  /**
   * Onboarding-incomplete users: message history is captured for real (so
   * nothing is lost once the AI layer lands), but the actual conversational
   * reply is a placeholder — OnboardingService.buildPrompt/
   * extractStructuredField are TODOs (Phase 3/4, deliberately deferred).
   * Onboarding-complete users: TODO (Phase 8) — free-text intent
   * classification (transfer / settings-change / spend-summary / general
   * chat) needs the AI layer too.
   */
  private async handleText(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    if (user.onboardingStage !== OnboardingStage.COMPLETE) {
      const session = await this.onboarding.getOrStartSession(user.id);
      await this.onboarding.appendMessage(
        session.id,
        "user",
        message.textBody ?? "",
      );
      await this.whatsapp.sendText(
        message.fromNumber,
        "Thanks — I've got that noted. Kedu's onboarding conversation isn't fully wired up yet, but nothing you say here is lost.",
        user.id,
      );
      return;
    }

    await this.whatsapp.sendText(
      message.fromNumber,
      "Kedu's conversation engine isn't fully wired up yet — hang tight.",
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
