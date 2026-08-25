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
import {
  parseManagerCommand,
  parseTransferCommand,
  isSpendSummaryQuery,
} from "./parsers/text-command.parser";
import { User, WhatsappMessage, WhatsappMessageType } from "@prisma/client";
import { PinGateService } from "./pin-gate.service";
import { SensitiveFields } from "./whatsapp-message.service";

// Quick-access keyword shortcuts — same actions the "menu" list offers,
// reachable without opening the menu first. Deliberately not a fuzzy/AI
// match: exact keywords only, consistent with the rest of the stopgap
// command parsing.
const BALANCE_RE = /^balance$/i;
const BALANCE_PARAPHRASE_RE =
  /^(check\s+)?balance\b|^how much do i have\b|^what(?:'s| is) in my account\b/i;
const LIMITS_RE = /^limits?$/i;
const LIMITS_PARAPHRASE_RE =
  /^how much can i (still )?spend\b|^what(?:'s| is) left (for )?today\b|^daily limit\b/i;
const ACCOUNT_DETAILS_RE = /^account( details)?$/i;
const TRANSFER_START_RE = /^(send money|transfer)$/i;

/**
 * The top-level inbound decision tree (PRD §5: webhook-in -> window check ->
 * allowance check -> ... -> response-out).
 *
 * Free-text transfer/settings-change/summary intent is still a small set of
 * structured stopgap commands (parsers/text-command.parser.ts), not real NLP
 * classification — deliberately honest about that; nothing downstream
 * depends on it changing. Post-onboarding free text that doesn't match a
 * shortcut goes through the AI Orchestrator + ActionExecutor.
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
    private readonly accountActions: AccountActionsService,
    private readonly pinGate: PinGateService,
    private readonly orchestrator: OrchestratorService,
    private readonly actionExecutor: ActionExecutorService,
  ) {}

  /**
   * `sensitive` carries plaintext values (PIN, BVN/NIN) that were stripped
   * from the persisted `message` row — see whatsapp-message.service.ts. Only
   * the Flow-reply handlers read it; it is never logged or re-persisted.
   */
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
      "I can't listen to voice notes yet, could you type that instead?",
      user.id,
    );
  }

  /**
   * Dispatches by button-id namespace: confirm_transfer/cancel_transfer to
   * TransferConfirmationService; menu:/bank:/label: to AccountActionsService
   * (the interactive balance/limits/account/transfer surface); during
   * onboarding's STRUCTURED_QUESTIONS stage, everything else goes to
   * OnboardingService's list-reply handler.
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
        return this.accountActions.startTransferWizard(user);
      default:
        this.logger.warn(`Unrecognized menu selection "${payload}"`);
    }
  }

  /**
   * A WhatsApp Flow submission — currently only the Trust Moment's KYC form
   * (see OnboardingService.handleInboundFlowReply). Not meaningful outside a
   * pre-account onboarding stage since nothing else in the app sends a flow.
   */
  private async handleFlowReply(
    user: User,
    message: WhatsappMessage,
    sensitive: SensitiveFields,
  ): Promise<void> {
    const responseJson =
      (message.flowResponseJson as Record<string, unknown> | null) ?? {};

    // A PIN submission is identified by its challenge, not by the stage the
    // user happens to be in — PIN entry is post-onboarding, so the
    // pre-account gate below would otherwise reject it. handlePinFlowReply
    // returns "none" for any token that isn't a live PIN challenge, so a KYC
    // submission falls through to the onboarding handler untouched.
    if (sensitive.pin !== undefined || sensitive.pin_confirm !== undefined) {
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
   * Pre-account-stage users (still in the onboarding script) go entirely to
   * OnboardingService — the interactive account-actions surface below
   * (balance/limits/account/transfer) needs a real Rubies account to act on,
   * so it's only reachable past that point.
   *
   * For everyone else: an in-progress send-money wizard step takes priority
   * over everything; then structured stopgap commands/keyword shortcuts
   * (deterministic, zero-latency). Anything that still doesn't match goes
   * through OrchestratorService + ActionExecutorService.
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

    const activeDraft = await this.accountActions.getActiveDraft(user.id);
    if (activeDraft) {
      await this.accountActions.handleWizardText(user, activeDraft.id, text);
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

    if (BALANCE_RE.test(text.trim()) || BALANCE_PARAPHRASE_RE.test(text.trim())) {
      await this.accountActions.sendBalance(user);
      return;
    }
    if (LIMITS_RE.test(text.trim()) || LIMITS_PARAPHRASE_RE.test(text.trim())) {
      await this.accountActions.sendLimitsStatus(user);
      return;
    }
    if (ACCOUNT_DETAILS_RE.test(text.trim())) {
      await this.accountActions.sendAccountDetails(user);
      return;
    }
    if (TRANSFER_START_RE.test(text.trim())) {
      await this.accountActions.startTransferWizard(user);
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
      await this.accountActions.sendMainMenu(user);
      return;
    }

    // ── AI Orchestrator + Action Executor ───────────────────────────
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
