import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import {
  OnboardingService,
  isPreAccountStage,
} from "../onboarding/onboarding.service";
import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "./transfer-confirmation.service";
import { OrchestratorService } from "../orchestrator/orchestrator.service";
import { ActionExecutorService } from "../orchestrator/action-executor.service";
import {
  AccountActionsService,
  BANK_BUTTON_PREFIX,
  LABEL_BUTTON_PREFIX,
  MENU_ACCOUNT,
  MENU_BALANCE,
  MENU_BUTTON_PREFIX,
  MENU_LIMITS,
  MENU_TRANSFER,
} from "./account-actions.service";
import { User, WhatsappMessage, WhatsappMessageType } from "@prisma/client";
import { PinGateService } from "./pin-gate.service";
import {
  WeeklyReviewService,
  WEEKLY_REVIEW_PREFIX,
} from "./weekly-review.service";
import { SensitiveFields } from "./whatsapp-message.service";
import { isMenuShortcut } from "./menu-shortcut.util";

/**
 * Top-level inbound router.
 *
 * Structured WhatsApp payloads (button ids, list ids, Flow JSON, PIN) stay
 * deterministic. All post-onboarding free text goes to the LLM orchestrator —
 * no regex product path for intent or transfer field extraction.
 */
@Injectable()
export class WhatsappRouterService {
  private readonly logger = new Logger(WhatsappRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly onboarding: OnboardingService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly accountActions: AccountActionsService,
    private readonly pinGate: PinGateService,
    private readonly orchestrator: OrchestratorService,
    private readonly actionExecutor: ActionExecutorService,
    private readonly weeklyReview: WeeklyReviewService,
  ) {}

  async route(
    message: WhatsappMessage,
    sensitive: SensitiveFields = {},
  ): Promise<void> {
    const user = await this.findOrCreateUser(message.fromNumber);

    switch (message.type) {
      case WhatsappMessageType.AUDIO:
        return this.handleAudio(user, message);
      case WhatsappMessageType.BUTTON_REPLY:
      case WhatsappMessageType.LIST_REPLY:
        return this.handleButtonReply(user, message);
      case WhatsappMessageType.FLOW_REPLY:
        return this.handleFlowReply(user, message, sensitive);
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

  private async handleAudio(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    await this.whatsapp.sendText(
      message.fromNumber,
      "I can't listen to voice notes yet, could you type that instead?",
      user.id,
    );
  }

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

    if (payload.startsWith(MENU_BUTTON_PREFIX)) {
      await this.handleMenuSelection(user, payload);
      return;
    }
    if (
      payload.startsWith(BANK_BUTTON_PREFIX) ||
      payload.startsWith(LABEL_BUTTON_PREFIX)
    ) {
      const draft = await this.accountActions.getActiveDraft(user.id);
      if (!draft) {
        await this.whatsapp.sendText(
          message.fromNumber,
          'that request has expired, say "transfer" to start again.',
          user.id,
        );
        return;
      }
      await this.accountActions.handleWizardSelection(user, draft.id, payload);
      return;
    }

    if (payload.startsWith(WEEKLY_REVIEW_PREFIX)) {
      await this.weeklyReview.handleChoice(user, payload);
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
      "Got it, I'm not able to act on that yet, this part of Udara isn't wired up.",
      user.id,
    );
  }

  private async handleMenuSelection(
    user: User,
    payload: string,
  ): Promise<void> {
    switch (payload) {
      case MENU_BALANCE:
        return this.accountActions.sendBalance(user);
      case MENU_LIMITS:
        return this.accountActions.sendLimitsStatus(user);
      case MENU_ACCOUNT:
        return this.accountActions.sendAccountDetails(user);
      case MENU_TRANSFER:
        return this.accountActions.startTransferWizard(user, undefined, {
          recoverFromSession: false,
        });
      default:
        this.logger.warn(`Unrecognized menu selection "${payload}"`);
    }
  }

  private async handleFlowReply(
    user: User,
    message: WhatsappMessage,
    sensitive: SensitiveFields,
  ): Promise<void> {
    const responseJson =
      (message.flowResponseJson as Record<string, unknown> | null) ?? {};

    if (
      sensitive.pin !== undefined ||
      sensitive.pin_confirm !== undefined ||
      sensitive.otp !== undefined
    ) {
      const outcome = await this.pinGate.handlePinFlowReply(
        user,
        responseJson,
        sensitive,
      );
      if (outcome.action === "execute_transfer") {
        await this.transferConfirmation.executeVerifiedTransfer(
          outcome.transactionId,
        );
      }
      if (outcome.action === "pin_setup_complete") {
        await this.transferConfirmation.resumeAfterPinSetup(user.id);
      }
      return;
    }

    if (!isPreAccountStage(user.onboardingStage)) {
      this.logger.warn(
        `FLOW_REPLY from ${message.fromNumber} at post-account stage ${user.onboardingStage} — nothing to route it to`,
      );
      return;
    }
    await this.onboarding.handleInboundFlowReply(user, responseJson, sensitive);
  }

  /**
   * Pre-account onboarding stays scripted. Post-onboarding free text always
   * goes to the orchestrator (including when a transfer draft is active —
   * the model sees Active mode and can fill_wizard or cancel_surface).
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

    // An in-flight weekly-limit adjustment owns the next message: it's the
    // answer to a question we just asked, not a new command for the
    // orchestrator to classify.
    const awaitingLimit = await this.weeklyReview.getReviewAwaitingLimit(
      user.id,
    );
    if (awaitingLimit) {
      await this.weeklyReview.handleLimitText(user, awaitingLimit, text);
      return;
    }

    if (isMenuShortcut(text)) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "here's everything you can do with me.",
        user.id,
      );
      await this.accountActions.sendMainMenu(user);
      return;
    }

    const result = await this.orchestrator.handleMessage(user, text);
    await this.actionExecutor.execute(user, result);
  }

  private async handleUnsupportedMedia(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    await this.whatsapp.sendText(
      message.fromNumber,
      "I can't do anything with that kind of message yet, could you send it as text?",
      user.id,
    );
  }
}
