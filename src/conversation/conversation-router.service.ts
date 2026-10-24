import { Injectable, Logger } from "@nestjs/common";
import { TransferDraftStep, User } from "@prisma/client";
import {
  OnboardingService,
  isPreAccountStage,
} from "../onboarding/onboarding.service";
import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "../whatsapp/transfer-confirmation.service";
import { BillPaymentActionsService } from "../whatsapp/bill-payment-actions.service";
import { BillPaymentConfirmationService } from "../whatsapp/bill-payment-confirmation.service";
import {
  BUNDLE_BUTTON_PREFIX,
  CANCEL_BILL_PREFIX,
  CONFIRM_BILL_PREFIX,
  DATA_TELCO_BUTTON_PREFIX,
  DISCO_BUTTON_PREFIX,
  TELCO_BUTTON_PREFIX,
} from "../whatsapp/bill-payment.constants";
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
} from "../whatsapp/account-actions.service";
import { BillPaymentDraftStep } from "../prisma/bill-payment.enums";
import { PinGateService } from "../whatsapp/pin-gate.service";
import { PinOutcomeService } from "../whatsapp/pin-outcome.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import {
  WeeklyReviewService,
  WEEKLY_REVIEW_PREFIX,
} from "../whatsapp/weekly-review.service";
import { SensitiveFields } from "../whatsapp/whatsapp-message.service";
import {
  isMenuShortcut,
  menuPayloadFromUtterance,
} from "../whatsapp/menu-shortcut.util";
import { isShortCompletionAck } from "../orchestrator/transfer-hints.util";
import { parseLimitAnswer } from "../common/naira-amount.util";
import { isCancelWord } from "../common/cancel-words.util";
import { OrchestratorTurnOptions } from "../orchestrator/orchestrator.types";

const PIN_SETUP_REMINDER =
  "set your transfer pin first, then we'll carry on. here's the form again:";

/**
 * What a user said, on whichever channel, turned into what Udara does.
 *
 * Structured input (button and list ids, forms) stays deterministic. All
 * post-onboarding free text goes to the LLM orchestrator; there is no regex
 * product path for intent or transfer field extraction.
 *
 * Channel-neutral: it never looks at how a message arrived. Callers open the
 * channel context and the turn (TurnService) and hand it the user as read
 * inside that turn. Replies go back through ChannelMessenger, which answers on
 * the channel in context.
 */
@Injectable()
export class ConversationRouterService {
  private readonly logger = new Logger(ConversationRouterService.name);

  constructor(
    private readonly onboarding: OnboardingService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly billPaymentActions: BillPaymentActionsService,
    private readonly billPaymentConfirmation: BillPaymentConfirmationService,
    private readonly accountActions: AccountActionsService,
    private readonly pinGate: PinGateService,
    private readonly orchestrator: OrchestratorService,
    private readonly actionExecutor: ActionExecutorService,
    private readonly weeklyReview: WeeklyReviewService,
    private readonly pinOutcome: PinOutcomeService,
    private readonly messenger: ChannelMessenger,
  ) {}

  /** A button or list row the user picked, by its id. */
  async handleChoice(user: User, payload: string): Promise<void> {
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
      if (await this.remindedOfPinSetup(user)) return;
      await this.onboarding.handleInboundButton(user, payload);
      return;
    }

    this.logger.debug(`Choice "${payload}" from user ${user.id} — not routed`);
    await this.messenger.sendText(
      user,
      "Got it, I'm not able to act on that yet, this part of Udara isn't wired up.",
    );
  }

  /**
   * A submitted PIN form (entry, setup or reset). `form` carries the
   * `flow_token`; the PIN, confirmation and emailed code are only ever in
   * `sensitive`, in memory.
   */
  async handlePinForm(
    user: User,
    form: Record<string, unknown>,
    sensitive: SensitiveFields,
  ): Promise<void> {
    const outcome = await this.pinGate.handlePinFlowReply(
      user,
      form,
      sensitive,
    );
    await this.pinOutcome.apply(outcome, user.id);
  }

  /** A submitted identity (KYC) form. The ID number and date of birth are in `sensitive`. */
  async handleKycForm(
    user: User,
    form: Record<string, unknown>,
    sensitive: SensitiveFields,
  ): Promise<void> {
    if (!isPreAccountStage(user.onboardingStage)) {
      this.logger.warn(
        `KYC form from user ${user.id} at post-account stage ${user.onboardingStage} — nothing to route it to`,
      );
      return;
    }
    await this.onboarding.handleInboundFlowReply(user, form, sensitive);
    // An app-only user is asked for a PIN as soon as their account exists
    // (ADR-0002); onboarding holds until it is set.
    if (await this.onboarding.isAwaitingPinSetup(user.id)) {
      await this.pinGate.requestPinSetup(user);
    }
  }

  /**
   * Pre-account onboarding stays scripted. Post-onboarding free text goes
   * to the orchestrator except a parseable amount (or cancel) while a
   * weekly review is AWAITING_LIMIT. Active transfer drafts still reach
   * the model so it can fill_wizard or cancel_surface.
   */
  async handleText(
    user: User,
    text: string,
    options: OrchestratorTurnOptions = {},
  ): Promise<void> {
    if (isPreAccountStage(user.onboardingStage)) {
      if (await this.remindedOfPinSetup(user)) return;
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

  /**
   * While an app-only user owes a PIN, nothing else in onboarding moves: every
   * message gets the form again. True when it answered.
   */
  private async remindedOfPinSetup(user: User): Promise<boolean> {
    if (!(await this.onboarding.isAwaitingPinSetup(user.id))) return false;
    await this.messenger.sendText(user, PIN_SETUP_REMINDER);
    await this.pinGate.requestPinSetup(user);
    return true;
  }
}
