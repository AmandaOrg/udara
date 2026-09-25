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
import { BillPaymentActionsService } from "./bill-payment-actions.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import {
  BUNDLE_BUTTON_PREFIX,
  CANCEL_BILL_PREFIX,
  CONFIRM_BILL_PREFIX,
  DATA_TELCO_BUTTON_PREFIX,
  DISCO_BUTTON_PREFIX,
  TELCO_BUTTON_PREFIX,
} from "./bill-payment.constants";
import { OrchestratorService } from "../orchestrator/orchestrator.service";
import { ActionExecutorService } from "../orchestrator/action-executor.service";
import {
  AccountActionsService,
  BANK_BUTTON_PREFIX,
  BENEFICIARY_BUTTON_PREFIX,
  LABEL_BUTTON_PREFIX,
  MENU_ACCOUNT,
  MENU_BALANCE,
  MENU_BUTTON_PREFIX,
  MENU_LIMITS,
  MENU_TRANSFER,
  MENU_AIRTIME,
  MENU_DATA,
  MENU_ELECTRICITY,
} from "./account-actions.service";
import {
  Prisma,
  User,
  WhatsappMessage,
  WhatsappMessageType,
  TransferDraftStep,
} from "@prisma/client";
import { BillPaymentDraftStep } from "../prisma/bill-payment.enums";
import { PinGateService } from "./pin-gate.service";
import { PinOutcomeService } from "./pin-outcome.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import {
  WeeklyReviewService,
  WEEKLY_REVIEW_PREFIX,
} from "./weekly-review.service";
import {
  SensitiveFields,
  WhatsappMessageService,
} from "./whatsapp-message.service";
import { isMenuShortcut, menuPayloadFromUtterance } from "./menu-shortcut.util";
import { isShortCompletionAck } from "../orchestrator/transfer-hints.util";
import { parseLimitAnswer } from "../common/naira-amount.util";
import { isCancelWord } from "../common/cancel-words.util";
import { DeepgramService } from "./deepgram.service";
import { InboundRateLimitService } from "./inbound-rate-limit.service";
import { OrchestratorTurnOptions } from "../orchestrator/orchestrator.types";

const AUDIO_TYPE_INSTEAD =
  "I can't listen to voice notes yet, could you type that instead?";
const AUDIO_COULDNT_HEAR = "I couldn't hear that clearly, could you type it?";
const IMAGE_COULDNT_OPEN =
  "I couldn't open that photo, could you type what you meant?";
const VISION_MAX_BYTES = 16 * 1024 * 1024;

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
    private readonly billPaymentActions: BillPaymentActionsService,
    private readonly billPaymentConfirmation: BillPaymentConfirmationService,
    private readonly accountActions: AccountActionsService,
    private readonly pinGate: PinGateService,
    private readonly orchestrator: OrchestratorService,
    private readonly actionExecutor: ActionExecutorService,
    private readonly weeklyReview: WeeklyReviewService,
    private readonly deepgram: DeepgramService,
    private readonly inboundMessages: WhatsappMessageService,
    private readonly rateLimit: InboundRateLimitService,
    private readonly pinOutcome: PinOutcomeService,
    private readonly messenger: ChannelMessenger,
  ) {}

  async route(
    message: WhatsappMessage,
    sensitive: SensitiveFields = {},
  ): Promise<void> {
    const user = await this.findOrCreateUser(message.fromNumber);
    // Must precede the rate check, which counts this user's inbound rows.
    await this.inboundMessages.attachUser(message.id, user.id);

    // Before any handler: past this point a message can cost an LLM call, a
    // media download and a transcription, and nothing else bounds that.
    const rate = await this.rateLimit.check(user.id);
    if (rate.limited) {
      if (rate.justCrossed) {
        await this.messenger.sendText(
          user,
          "that's a lot of messages at once. give me a few minutes and try again.",
        );
      }
      return;
    }

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
        return this.handleImage(user, message);
      case WhatsappMessageType.DOCUMENT:
      case WhatsappMessageType.LOCATION:
        return this.handleUnsupportedMedia(user);
      case WhatsappMessageType.UNKNOWN:
      default:
        this.logger.warn(
          `Unhandled/unrecognized message type from ${message.fromNumber}`,
        );
        await this.messenger.sendText(
          user,
          "Sorry, I couldn't understand that message.",
        );
    }
  }

  /**
   * The sender's User, creating or linking one as needed.
   *
   * Meta's sender id is already the canonical phone number (see
   * common/phone.util.ts), so a number that signed up in the app and now
   * messages on WhatsApp for the first time is found by phoneNumber and linked
   * rather than given a second account with a second set of limits.
   */
  private async findOrCreateUser(whatsappNumber: string): Promise<User> {
    const now = new Date();
    const onWhatsapp = await this.prisma.user.findUnique({
      where: { whatsappNumber },
    });
    if (onWhatsapp) {
      return this.prisma.user.update({
        where: { id: onWhatsapp.id },
        data: { lastInboundMessageAt: now },
      });
    }

    const linked = await this.linkWhatsapp(whatsappNumber, now);
    if (linked) return linked;

    try {
      return await this.prisma.user.create({
        data: {
          phoneNumber: whatsappNumber,
          whatsappNumber,
          lastInboundMessageAt: now,
        },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      ) {
        throw err;
      }
      // Lost a race: a redelivered webhook for this number, or an app sign-up
      // with it, created the row between the lookups above and this insert.
      const winner =
        (await this.prisma.user.findUnique({ where: { whatsappNumber } })) ??
        (await this.linkWhatsapp(whatsappNumber, now));
      if (winner) return winner;
      throw new Error(
        `findOrCreateUser: phone number ${whatsappNumber} is taken by a user already linked to a different WhatsApp number`,
      );
    }
  }

  /**
   * Links this WhatsApp number to the account holding the same phone number.
   * Conditional on that account having no WhatsApp number yet, so an existing
   * link is never overwritten, and two racing first messages link it once.
   */
  private async linkWhatsapp(
    whatsappNumber: string,
    now: Date,
  ): Promise<User | null> {
    const { count } = await this.prisma.user.updateMany({
      where: { phoneNumber: whatsappNumber, whatsappNumber: null },
      data: { whatsappNumber, lastInboundMessageAt: now },
    });
    if (count === 0) return null;
    return this.prisma.user.findUnique({ where: { whatsappNumber } });
  }

  private async handleAudio(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    if (!this.deepgram.isConfigured()) {
      this.logger.warn(
        "Voice note ignored: DEEPGRAM_API_KEY is not set on this process",
      );
      await this.messenger.sendText(user, AUDIO_TYPE_INSTEAD);
      return;
    }
    const mediaId = message.mediaId ?? "";
    if (!mediaId) {
      await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
      return;
    }
    try {
      const { buffer, mimeType } = await this.whatsapp.downloadMedia(mediaId);
      const heard = await this.deepgram.transcribe(buffer, mimeType);
      if (!heard.ok || !heard.text) {
        await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
        return;
      }
      await this.inboundMessages.updateTextBody(message.id, heard.text);
      await this.handleUserUtterance(user, heard.text);
    } catch (err) {
      this.logger.warn(`Audio download/STT failed: ${String(err)}`);
      await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
    }
  }

  private async handleImage(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const caption = (message.textBody ?? "").trim();
    if (isPreAccountStage(user.onboardingStage)) {
      await this.onboarding.handleInboundText(
        user,
        caption || "(user sent a photo)",
      );
      return;
    }
    const mediaId = message.mediaId ?? "";
    if (!mediaId) {
      await this.messenger.sendText(user, IMAGE_COULDNT_OPEN);
      return;
    }
    try {
      const { buffer, mimeType } = await this.whatsapp.downloadMedia(mediaId);
      const syntheticText = caption.length === 0;
      const text = caption || "(user sent a photo)";
      let image: OrchestratorTurnOptions["image"];
      if (buffer.length > 0 && buffer.length <= VISION_MAX_BYTES) {
        image = {
          mimeType: mimeType || "image/jpeg",
          data: buffer.toString("base64"),
        };
      }
      await this.handleUserUtterance(user, text, { image, syntheticText });
    } catch (err) {
      this.logger.warn(`Image download failed: ${String(err)}`);
      await this.messenger.sendText(user, IMAGE_COULDNT_OPEN);
    }
  }

  private async handleButtonReply(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const payload = message.buttonPayload ?? "";

    if (payload.startsWith(CONFIRM_BUTTON_PREFIX)) {
      const transactionId = payload.slice(CONFIRM_BUTTON_PREFIX.length);
      await this.transferConfirmation.confirmTransfer(user.id, transactionId);
      return;
    }
    if (payload.startsWith(CANCEL_BUTTON_PREFIX)) {
      const transactionId = payload.slice(CANCEL_BUTTON_PREFIX.length);
      await this.transferConfirmation.cancelTransfer(user.id, transactionId);
      return;
    }
    if (payload.startsWith(CONFIRM_BILL_PREFIX)) {
      const billPaymentId = payload.slice(CONFIRM_BILL_PREFIX.length);
      await this.billPaymentConfirmation.confirmBillPayment(
        user.id,
        billPaymentId,
      );
      return;
    }
    if (payload.startsWith(CANCEL_BILL_PREFIX)) {
      const billPaymentId = payload.slice(CANCEL_BILL_PREFIX.length);
      await this.billPaymentConfirmation.cancelBillPayment(
        user.id,
        billPaymentId,
      );
      return;
    }
    if (payload.startsWith(TELCO_BUTTON_PREFIX)) {
      const billerCode = payload.slice(TELCO_BUTTON_PREFIX.length);
      const draft = await this.billPaymentActions.getActiveDraft(user.id);
      if (!draft) {
        await this.messenger.sendText(
          user,
          'that request has expired, say "airtime" to start again.',
        );
        return;
      }
      await this.billPaymentActions.handleAirtimeTelcoSelection(
        user,
        draft.id,
        billerCode,
      );
      return;
    }
    if (payload.startsWith(DATA_TELCO_BUTTON_PREFIX)) {
      const billerCode = payload.slice(DATA_TELCO_BUTTON_PREFIX.length);
      const draft = await this.billPaymentActions.getActiveDraft(user.id);
      if (!draft) {
        await this.messenger.sendText(
          user,
          'that request has expired, say "data" to start again.',
        );
        return;
      }
      await this.billPaymentActions.handleDataTelcoSelection(
        user,
        draft.id,
        billerCode,
      );
      return;
    }
    if (payload.startsWith(BUNDLE_BUTTON_PREFIX)) {
      const rest = payload.slice(BUNDLE_BUTTON_PREFIX.length);
      const [billerCode, productCode] = rest.split(":");
      const draft = await this.billPaymentActions.getActiveDraft(user.id);
      if (!draft || !billerCode || !productCode) {
        await this.messenger.sendText(
          user,
          'that request has expired, say "data" to start again.',
        );
        return;
      }
      await this.billPaymentActions.handleBundleSelection(
        user,
        draft.id,
        billerCode,
        productCode,
      );
      return;
    }
    if (payload.startsWith(DISCO_BUTTON_PREFIX)) {
      const billerCode = payload.slice(DISCO_BUTTON_PREFIX.length);
      const draft = await this.billPaymentActions.getActiveDraft(user.id);
      if (!draft) {
        await this.messenger.sendText(
          user,
          'that request has expired, say "electricity" to start again.',
        );
        return;
      }
      await this.billPaymentActions.handleDiscoSelection(
        user,
        draft.id,
        billerCode,
      );
      return;
    }

    if (payload.startsWith(MENU_BUTTON_PREFIX)) {
      await this.handleMenuSelection(user, payload);
      return;
    }
    if (payload.startsWith(BENEFICIARY_BUTTON_PREFIX)) {
      const recipientId = payload.slice(BENEFICIARY_BUTTON_PREFIX.length);
      await this.accountActions.handleBeneficiarySelection(user, recipientId);
      return;
    }
    if (
      payload.startsWith(BANK_BUTTON_PREFIX) ||
      payload.startsWith(LABEL_BUTTON_PREFIX)
    ) {
      const draft = await this.accountActions.getActiveDraft(user.id);
      if (!draft) {
        await this.messenger.sendText(
          user,
          'that request has expired, say "transfer" to start again.',
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
    await this.messenger.sendText(
      user,
      "Got it, I'm not able to act on that yet, this part of Udara isn't wired up.",
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
      case MENU_AIRTIME:
        return this.billPaymentActions.startAirtimeWizard(user);
      case MENU_DATA:
        return this.billPaymentActions.startDataWizard(user);
      case MENU_ELECTRICITY:
        return this.billPaymentActions.startElectricityWizard(user);
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
      await this.pinOutcome.apply(outcome, user.id);
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
   * Pre-account onboarding stays scripted. Post-onboarding free text goes
   * to the orchestrator except a parseable amount (or cancel) while a
   * weekly review is AWAITING_LIMIT. Active transfer drafts still reach
   * the model so it can fill_wizard or cancel_surface.
   */
  private async handleText(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    await this.handleUserUtterance(user, message.textBody ?? "");
  }

  private async handleUserUtterance(
    user: User,
    text: string,
    options: OrchestratorTurnOptions = {},
  ): Promise<void> {
    if (isPreAccountStage(user.onboardingStage)) {
      await this.onboarding.handleInboundText(user, text);
      return;
    }

    if (isMenuShortcut(text)) {
      await this.accountActions.sendMainMenu(user);
      return;
    }

    const menuRow = menuPayloadFromUtterance(text);
    if (menuRow) {
      await this.handleMenuSelection(user, menuRow);
      return;
    }

    const billDraft = await this.billPaymentActions.getActiveDraft(user.id);
    if (billDraft) {
      if (isCancelWord(text)) {
        await this.billPaymentActions.cancelDraft(user, billDraft.id);
        return;
      }
      const textSteps: BillPaymentDraftStep[] = [
        BillPaymentDraftStep.AWAITING_AMOUNT,
        BillPaymentDraftStep.AWAITING_MSISDN,
        BillPaymentDraftStep.AWAITING_METER,
      ];
      if (textSteps.includes(billDraft.step)) {
        await this.billPaymentActions.handleWizardText(
          user,
          billDraft.id,
          text,
        );
        return;
      }
    }

    const transferDraft = await this.accountActions.getActiveDraft(user.id);
    if (
      transferDraft &&
      transferDraft.step === TransferDraftStep.AWAITING_PURPOSE_NOTE
    ) {
      await this.accountActions.handleWizardText(user, transferDraft.id, text);
      return;
    }

    // The weekly-review wait is checked *after* the wizards, not before.
    // Running it first meant a "500" typed for an airtime purchase was read as
    // a daily limit and rejected as too low, and a "cancel" meant for that
    // wizard acknowledged the review instead and left the wizard live to
    // swallow the next number the user typed.
    //
    // Synthetic text is skipped entirely: a captionless photo arrives as the
    // literal "(user sent a photo)", which is not an answer to anything.
    let abandonedReview = false;
    if (!options.syntheticText) {
      const awaitingLimit = await this.weeklyReview.getReviewAwaitingLimit(
        user.id,
      );
      if (awaitingLimit) {
        if (isCancelWord(text)) {
          await this.weeklyReview.abandonAwaitingLimit(user, awaitingLimit);
          return;
        }
        const amount = parseLimitAnswer(text);
        if (amount != null) {
          await this.weeklyReview.handleLimitAmount(
            user,
            awaitingLimit,
            amount,
          );
          return;
        }
        // Not an answer, so drop the wait — but say so, and carry on with the
        // utterance. Dropping it silently is what made a mistyped limit vanish
        // with no trace and no way to retry.
        await this.weeklyReview.abandonAwaitingLimit(user, awaitingLimit);
        abandonedReview = true;
      }
    }

    // `abandonedReview` suppresses this: having just told the user their limits
    // are unchanged, "glad that went through." is both a non-sequitur and a
    // claim that something succeeded when nothing did.
    if (
      isShortCompletionAck(text) &&
      !billDraft &&
      !transferDraft &&
      !abandonedReview
    ) {
      await this.messenger.sendText(user, "glad that went through.");
      return;
    }

    const result = await this.orchestrator.handleMessage(user, text, options);
    await this.actionExecutor.execute(user, result);
  }

  private async handleUnsupportedMedia(user: User): Promise<void> {
    await this.messenger.sendText(
      user,
      "I can't do anything with that kind of message yet, could you send it as text?",
    );
  }
}
