import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { WindowService } from "../allowance/window.service";
import { RubiesService } from "../rubies/rubies.service";
import { TaggingService } from "../tagging/tagging.service";
import { WhatsappService } from "./whatsapp.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { BankInfo, BankMatchResult, matchBanks } from "../common/bank-match.util";
import { TransferWizardHints } from "../orchestrator/transfer-hints.util";
import {
  ConversationPersona,
  ConversationSessionStatus,
  Prisma,
  RecipientLabel,
  TransactionStatus,
  TransferDraft,
  TransferDraftStatus,
  TransferDraftStep,
  User,
} from "@prisma/client";

export const MENU_BUTTON_PREFIX = "menu:";
export const BANK_BUTTON_PREFIX = "bank:";
export const LABEL_BUTTON_PREFIX = "label:";
export const BENEFICIARY_BUTTON_PREFIX = "beneficiary:";

export const MENU_BALANCE = `${MENU_BUTTON_PREFIX}balance`;
export const MENU_LIMITS = `${MENU_BUTTON_PREFIX}limits`;
export const MENU_ACCOUNT = `${MENU_BUTTON_PREFIX}account`;
export const MENU_TRANSFER = `${MENU_BUTTON_PREFIX}transfer`;

const CANCEL_WORDS = /^(cancel|stop|nevermind|never mind)$/i;

const LABEL_ROWS = [
  { id: `${LABEL_BUTTON_PREFIX}RENT`, title: "🏠 Rent" },
  { id: `${LABEL_BUTTON_PREFIX}FOOD`, title: "🍔 Food" },
  { id: `${LABEL_BUTTON_PREFIX}VENDOR`, title: "🏪 Vendor" },
  { id: `${LABEL_BUTTON_PREFIX}OTHER`, title: "📦 Other" },
];

/**
 * The interactive (button/list-driven) account-actions surface: balance,
 * spending-limit status, account details, and the send-money wizard.
 * Deliberately NOT AI chat — every reply here is a deterministic formatted
 * message or a WhatsApp list/button prompt, and it's only reachable once
 * onboarding is complete (WhatsappRouterService gates all of it on
 * !isPreAccountStage — there's no account to check balance/limits/transfer
 * on before then). Settings changes ("increase my limit", "let me exit
 * restrictions") stay on the Manager/chat path — this service only ever
 * reads discipline state or, for a transfer, hands off to
 * TransferConfirmationService; it never writes discipline state itself.
 */
@Injectable()
export class AccountActionsService {
  private readonly logger = new Logger(AccountActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly windowService: WindowService,
    private readonly rubies: RubiesService,
    private readonly tagging: TaggingService,
    private readonly whatsapp: WhatsappService,
    private readonly transferConfirmation: TransferConfirmationService,
  ) {}

  // =========================================================================
  // Menu
  // =========================================================================

  async sendMainMenu(user: User): Promise<void> {
    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      "what would you like to do?",
      "Open menu",
      [
        { id: MENU_BALANCE, title: "💰 Check balance" },
        { id: MENU_LIMITS, title: "📊 Spending limits" },
        { id: MENU_ACCOUNT, title: "🏦 Account details" },
        { id: MENU_TRANSFER, title: "💸 Send money" },
      ],
      user.id,
    );
  }

  // =========================================================================
  // Balance / limits / account details — plain reads, no state
  // =========================================================================

  async sendBalance(user: User): Promise<void> {
    if (!user.rubiesAccountNumber) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account yet.",
        user.id,
      );
      return;
    }

    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch(() => null);
    if (balance === null) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "couldn't reach rubies to check your balance right now, try again in a moment.",
        user.id,
      );
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `account balance: ₦${balance.toLocaleString("en-NG")}`,
      user.id,
    );
  }

  async sendLimitsStatus(user: User): Promise<void> {
    const { remainingToday, remainingWeek } =
      await this.allowance.getRemainingSummary(user.id);

    const lines = [
      `today's remaining allowance: ₦${remainingToday.toLocaleString("en-NG")}`,
      `remaining this week: ₦${remainingWeek.toLocaleString("en-NG")}`,
    ];

    if (user.disciplineExitedAt) {
      lines.push(
        "restrictions are off for your account, the spending window and override fees don't apply.",
      );
    } else if (
      this.windowService.isWithinWindow(
        user.windowStartHour,
        user.windowEndHour,
      )
    ) {
      lines.push(`spending window is open until ${user.windowEndHour}:00.`);
    } else {
      const hoursUntil = this.windowService.hoursUntilWindowOpens(
        user.windowStartHour,
      );
      lines.push(
        `spending window is closed, opens in about ${hoursUntil}h (${user.windowStartHour}:00).`,
      );
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      lines.join("\n"),
      user.id,
    );
  }

  async sendAccountDetails(user: User): Promise<void> {
    if (!user.rubiesAccountNumber) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account yet.",
        user.id,
      );
      return;
    }

    const lines = [
      `account number: ${user.rubiesAccountNumber}`,
      `account name: ${user.rubiesAccountName}`,
      "bank: rubies mfb",
    ];
    await this.whatsapp.sendText(
      user.whatsappNumber,
      lines.join("\n"),
      user.id,
    );
  }

  // =========================================================================
  // Send-money wizard — deterministic multi-step, button/list-driven.
  // State lives in TransferDraft (see schema), never in the AI chat's
  // ConversationSession — this is a separate, non-AI concern.
  // =========================================================================

  async getActiveDraft(userId: string): Promise<TransferDraft | null> {
    return this.prisma.transferDraft.findFirst({
      where: { userId, status: TransferDraftStatus.ACTIVE },
      orderBy: { createdAt: "desc" },
    });
  }

  async startTransferWizard(
    user: User,
    hints?: TransferWizardHints,
    _options?: { recoverFromSession?: boolean },
  ): Promise<void> {
    if (!user.rubiesAccountNumber) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account yet, so there's nothing to send from.",
        user.id,
      );
      return;
    }

    const resolved = await this.resolveBeneficiaryHints(user, hints ?? {});
    if (resolved === "disambiguation_sent") {
      return;
    }

    // Only one active draft at a time — starting fresh abandons any stale one.
    await this.prisma.transferDraft.updateMany({
      where: { userId: user.id, status: TransferDraftStatus.ACTIVE },
      data: { status: TransferDraftStatus.CANCELLED },
    });

    await this.advanceWithHints(user, resolved, null);
  }

  /**
   * User picked one of several saved beneficiaries after a disambiguation list.
   */
  async handleBeneficiarySelection(
    user: User,
    recipientId: string,
  ): Promise<void> {
    const pick = await this.readBeneficiaryPick(user.id);
    if (!pick) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        'that request has expired, say "transfer" to start again.',
        user.id,
      );
      return;
    }

    const recipient = await this.prisma.recipient.findFirst({
      where: { id: recipientId, userId: user.id },
    });
    if (!recipient) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "couldn't find that saved recipient, try again.",
        user.id,
      );
      return;
    }

    await this.clearBeneficiaryPick(user.id);
    const merged: TransferWizardHints = {
      ...pick.hints,
      accountNumber: recipient.accountNumber,
      bankCode: recipient.bankCode,
      beneficiaryName: pick.hints.beneficiaryName ?? recipient.nickname ?? undefined,
    };
    await this.startTransferWizard(user, merged);
  }

  /**
   * Merge LLM-extracted hints into the active draft. No-op if none is
   * open — fill_wizard must not start a new send.
   */
  async applyHintsToDraft(
    user: User,
    hints: TransferWizardHints,
  ): Promise<void> {
    if (!user.rubiesAccountNumber) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account yet, so there's nothing to send from.",
        user.id,
      );
      return;
    }

    const existing = await this.getActiveDraft(user.id);
    if (!existing) {
      this.logger.debug(
        `fill_wizard with no active draft for user ${user.id} — ignoring`,
      );
      return;
    }
    await this.advanceWithHints(user, hints, existing);
  }

  /**
   * If confirm/PIN is already in progress, resume that UI instead of a new wizard.
   */
  async resumePendingTransfer(user: User): Promise<boolean> {
    return this.transferConfirmation.resumePendingTransferUi(user);
  }

  /** Cancels active transfer draft and any pending confirm — silent (persona already spoke). */
  async cancelActiveSurfaces(user: User): Promise<void> {
    const draft = await this.getActiveDraft(user.id);
    if (draft) {
      await this.cancelDraft(user, draft.id, { silent: true });
    }
    await this.transferConfirmation.cancelPendingForUser(user.id, {
      silent: true,
    });
  }

  /**
   * Resolve bank fields from hints, persist draft state, and ask only for
   * whatever is still missing (or run name-enquiry when complete).
   */
  private async advanceWithHints(
    user: User,
    hints: TransferWizardHints,
    existing: TransferDraft | null,
  ): Promise<void> {
    let amount =
      hints.amount ??
      (existing?.amount != null ? Number(existing.amount) : undefined);
    let accountNumber = hints.accountNumber ?? existing?.accountNumber ?? undefined;
    let bankCode = hints.bankCode ?? existing?.bankCode ?? undefined;
    let bankName = hints.bankName ?? existing?.bankName ?? undefined;
    const labelHint = hints.labelHint ?? existing?.label ?? undefined;

    let bankMatch: BankMatchResult | null = null;

    if (!bankCode && bankName) {
      const banks = await this.rubies.listBanks();
      bankMatch = matchBanks(bankName, banks);
      if (bankMatch.kind === "single") {
        bankCode = bankMatch.bank.bankCode;
        bankName = bankMatch.bank.bankName;
      }
    } else if (bankCode) {
      const banks = await this.rubies.listBanks();
      const bank = banks.find((b) => b.bankCode === bankCode);
      if (bank) {
        bankName = bank.bankName;
      } else if (!existing?.bankCode) {
        bankCode = undefined;
      }
    }

    const draftData = {
      amount: amount ?? null,
      accountNumber: accountNumber ?? null,
      bankCode: bankCode ?? null,
      bankName: bankName ?? null,
      ...(labelHint ? { label: labelHint } : {}),
    };

    if (amount && accountNumber && bankCode && bankName) {
      const draft = existing
        ? await this.prisma.transferDraft.update({
            where: { id: existing.id },
            data: {
              ...draftData,
              step: TransferDraftStep.AWAITING_BANK_SELECTION,
            },
          })
        : await this.prisma.transferDraft.create({
            data: {
              userId: user.id,
              ...draftData,
              step: TransferDraftStep.AWAITING_BANK_SELECTION,
            },
          });
      await this.resolveBank(
        user,
        draft,
        bankCode,
        bankName,
        labelHint,
        hints.beneficiaryName,
      );
      return;
    }

    if (amount && accountNumber && bankMatch?.kind === "multiple") {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: {
            ...draftData,
            step: TransferDraftStep.AWAITING_BANK_SELECTION,
          },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            ...draftData,
            step: TransferDraftStep.AWAITING_BANK_SELECTION,
          },
        });
      }
      await this.promptBankList(user, bankMatch.banks);
      return;
    }

    if (amount && accountNumber) {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: {
            ...draftData,
            step: TransferDraftStep.AWAITING_BANK_SELECTION,
          },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            ...draftData,
            step: TransferDraftStep.AWAITING_BANK_SELECTION,
          },
        });
      }
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `got it, ₦${amount.toLocaleString("en-NG")} to ${accountNumber}. which bank? type the bank name (e.g. gtbank, access, zenith).`,
        user.id,
      );
      return;
    }

    if (amount && bankCode && bankName) {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: {
            ...draftData,
            step: TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
          },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            ...draftData,
            step: TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
          },
        });
      }
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `got it, ₦${amount.toLocaleString("en-NG")} to ${bankName}. what's the recipient's 10-digit account number?`,
        user.id,
      );
      return;
    }

    if (accountNumber && bankCode && bankName && !amount) {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: { ...draftData, step: TransferDraftStep.AWAITING_AMOUNT },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            ...draftData,
            step: TransferDraftStep.AWAITING_AMOUNT,
          },
        });
      }
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `how much would you like to send to ${accountNumber} at ${bankName}? (just the number, e.g. 5000)`,
        user.id,
      );
      return;
    }

    if (accountNumber && !amount) {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: { ...draftData, step: TransferDraftStep.AWAITING_AMOUNT },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            ...draftData,
            step: TransferDraftStep.AWAITING_AMOUNT,
          },
        });
      }
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `how much would you like to send to account ${accountNumber}? (just the number, e.g. 5000)`,
        user.id,
      );
      return;
    }

    if (amount !== undefined) {
      if (existing) {
        await this.prisma.transferDraft.update({
          where: { id: existing.id },
          data: {
            ...draftData,
            step: TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
          },
        });
      } else {
        await this.prisma.transferDraft.create({
          data: {
            userId: user.id,
            amount,
            step: TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
            ...(labelHint ? { label: labelHint } : {}),
          },
        });
      }
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `got it, ₦${amount.toLocaleString("en-NG")}. what's the recipient's 10-digit account number?`,
        user.id,
      );
      return;
    }

    if (existing) {
      await this.prisma.transferDraft.update({
        where: { id: existing.id },
        data: { ...draftData, step: TransferDraftStep.AWAITING_AMOUNT },
      });
    } else {
      await this.prisma.transferDraft.create({
        data: { userId: user.id, step: TransferDraftStep.AWAITING_AMOUNT },
      });
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "how much would you like to send? (just the number, e.g. 5000)",
      user.id,
    );
  }

  async cancelDraft(
    user: User,
    draftId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    await this.prisma.transferDraft.update({
      where: { id: draftId },
      data: { status: TransferDraftStatus.CANCELLED },
    });
    if (!options?.silent) {
      await this.whatsapp.sendText(user.whatsappNumber, "cancelled.", user.id);
    }
  }

  /**
   * Deterministic text handler for wizard steps. Prefer orchestrator
   * fill_wizard for free text; this remains for exact cancel words if called.
   */
  async handleWizardText(
    user: User,
    draftId: string,
    text: string,
  ): Promise<"handled" | "interrupt"> {
    if (CANCEL_WORDS.test(text.trim())) {
      await this.cancelDraft(user, draftId);
      return "handled";
    }

    const draft = await this.prisma.transferDraft.findUniqueOrThrow({
      where: { id: draftId },
    });

    switch (draft.step) {
      case TransferDraftStep.AWAITING_AMOUNT:
        await this.handleAmountText(user, draft, text);
        return "handled";
      case TransferDraftStep.AWAITING_ACCOUNT_NUMBER:
        await this.handleAccountNumberText(user, draft, text);
        return "handled";
      case TransferDraftStep.AWAITING_BANK_SELECTION:
        await this.handleBankNameText(user, draft, text);
        return "handled";
      default:
        await this.whatsapp.sendText(
          user.whatsappNumber,
          'tap one of the options above, or if you\'d rather start over, say "cancel".',
          user.id,
        );
        return "handled";
    }
  }

  /** Router calls this for BANK_BUTTON_PREFIX/LABEL_BUTTON_PREFIX list replies. */
  async handleWizardSelection(
    user: User,
    draftId: string,
    selectionId: string,
  ): Promise<void> {
    const draft = await this.prisma.transferDraft.findUniqueOrThrow({
      where: { id: draftId },
    });

    if (
      selectionId.startsWith(BANK_BUTTON_PREFIX) &&
      draft.step === TransferDraftStep.AWAITING_BANK_SELECTION
    ) {
      const bankCode = selectionId.slice(BANK_BUTTON_PREFIX.length);
      const banks = await this.rubies.listBanks();
      const bank = banks.find((b) => b.bankCode === bankCode);
      await this.resolveBank(user, draft, bankCode, bank?.bankName ?? bankCode);
      return;
    }

    if (
      selectionId.startsWith(LABEL_BUTTON_PREFIX) &&
      draft.step === TransferDraftStep.AWAITING_LABEL_SELECTION
    ) {
      const label = selectionId.slice(
        LABEL_BUTTON_PREFIX.length,
      ) as RecipientLabel;
      await this.finalizeTransfer(user, draft, label);
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "that doesn't match what I asked, let's try again.",
      user.id,
    );
  }

  private async handleAmountText(
    user: User,
    draft: TransferDraft,
    text: string,
  ): Promise<void> {
    const amount = Number(text.replace(/[₦,\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that doesn't look like a valid amount, just send the number, e.g. 5000.",
        user.id,
      );
      return;
    }

    const nextStep = draft.accountNumber
      ? TransferDraftStep.AWAITING_BANK_SELECTION
      : TransferDraftStep.AWAITING_ACCOUNT_NUMBER;

    await this.prisma.transferDraft.update({
      where: { id: draft.id },
      data: { amount, step: nextStep },
    });

    if (draft.accountNumber && draft.bankCode && draft.bankName) {
      const updated = await this.prisma.transferDraft.findUniqueOrThrow({
        where: { id: draft.id },
      });
      await this.resolveBank(
        user,
        updated,
        draft.bankCode,
        draft.bankName,
      );
      return;
    }

    if (draft.accountNumber) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `got it, ₦${amount.toLocaleString("en-NG")} to ${draft.accountNumber}. which bank? type the bank name (e.g. gtbank, access, zenith).`,
        user.id,
      );
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `got it, ₦${amount.toLocaleString("en-NG")}. what's the recipient's 10-digit account number?`,
      user.id,
    );
  }

  private async handleAccountNumberText(
    user: User,
    draft: TransferDraft,
    text: string,
  ): Promise<void> {
    const accountNumber = text.replace(/\D/g, "");
    if (accountNumber.length !== 10) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that should be a 10-digit account number, try again.",
        user.id,
      );
      return;
    }

    const updated = await this.prisma.transferDraft.update({
      where: { id: draft.id },
      data: { accountNumber },
    });

    if (updated.bankCode && updated.bankName) {
      await this.resolveBank(
        user,
        updated,
        updated.bankCode,
        updated.bankName,
      );
      return;
    }

    if (updated.bankName) {
      const banks = await this.rubies.listBanks();
      const result = matchBanks(updated.bankName, banks);

      if (result.kind === "single") {
        await this.resolveBank(
          user,
          updated,
          result.bank.bankCode,
          result.bank.bankName,
        );
        return;
      }

      if (result.kind === "multiple") {
        await this.prisma.transferDraft.update({
          where: { id: draft.id },
          data: { step: TransferDraftStep.AWAITING_BANK_SELECTION },
        });
        await this.promptBankList(user, result.banks);
        return;
      }
    }

    await this.prisma.transferDraft.update({
      where: { id: draft.id },
      data: { step: TransferDraftStep.AWAITING_BANK_SELECTION },
    });
    await this.whatsapp.sendText(
      user.whatsappNumber,
      "which bank? type the bank name (e.g. gtbank, access, zenith).",
      user.id,
    );
  }

  private async handleBankNameText(
    user: User,
    draft: TransferDraft,
    text: string,
  ): Promise<void> {
    const banks = await this.rubies.listBanks();
    const result = matchBanks(text, banks);

    if (result.kind === "none") {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "couldn't find that bank, try a different spelling, or the exact bank name.",
        user.id,
      );
      return;
    }

    if (result.kind === "single") {
      await this.resolveBank(
        user,
        draft,
        result.bank.bankCode,
        result.bank.bankName,
      );
      return;
    }

    if (result.kind === "too_many") {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `that matches ${result.count} banks, try typing more of the name.`,
        user.id,
      );
      return;
    }

    await this.promptBankList(user, result.banks);
  }

  private async promptBankList(
    user: User,
    banks: BankInfo[],
  ): Promise<void> {
    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      "a few banks match, which one?",
      "Pick a bank",
      banks.map((b) => ({
        id: `${BANK_BUTTON_PREFIX}${b.bankCode}`,
        title: b.bankName.slice(0, 24),
      })),
      user.id,
    );
  }

  /**
   * Runs name-enquiry once the account number + bank are both known — this
   * is the actual "account number and bank validation" step: an account
   * that doesn't resolve at the given bank sends the user back to re-enter
   * the account number rather than silently proceeding. Branches to
   * label-selection for a brand-new recipient, or straight to finalize for
   * one already tagged.
   */
  private async resolveBank(
    user: User,
    draft: TransferDraft,
    bankCode: string,
    bankName: string,
    labelHint?: RecipientLabel,
    beneficiaryNickname?: string,
  ): Promise<void> {
    if (!draft.accountNumber) {
      this.logger.error(
        `resolveBank called for draft ${draft.id} with no accountNumber set`,
      );
      return;
    }

    const resolved = await this.rubies
      .nameEnquiry({ accountNumber: draft.accountNumber, bankCode })
      .catch(() => null);

    if (!resolved) {
      await this.prisma.transferDraft.update({
        where: { id: draft.id },
        data: {
          step: TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
          accountNumber: null,
          bankCode: null,
          bankName: null,
        },
      });
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `couldn't verify that account at ${bankName}, double-check the account number and try again.`,
        user.id,
      );
      return;
    }

    const existingRecipient = await this.tagging.findRecipient(
      user.id,
      draft.accountNumber,
      bankCode,
    );

    const effectiveLabel = labelHint ?? draft.label ?? undefined;

    const purposeLabel =
      labelHint ?? draft.label ?? RecipientLabel.OTHER;

    if (existingRecipient) {
      const updated = await this.prisma.transferDraft.update({
        where: { id: draft.id },
        data: {
          bankCode,
          bankName,
          resolvedName: resolved.accountName,
          isNewRecipient: false,
        },
      });
      await this.finalizeTransfer(user, updated, existingRecipient.label, {
        purposeLabel,
        beneficiaryNickname,
      });
      return;
    }

    if (effectiveLabel) {
      const updated = await this.prisma.transferDraft.update({
        where: { id: draft.id },
        data: {
          bankCode,
          bankName,
          resolvedName: resolved.accountName,
          isNewRecipient: true,
        },
      });
      await this.finalizeTransfer(user, updated, effectiveLabel, {
        purposeLabel,
        beneficiaryNickname,
      });
      return;
    }

    await this.prisma.transferDraft.update({
      where: { id: draft.id },
      data: {
        bankCode,
        bankName,
        resolvedName: resolved.accountName,
        isNewRecipient: true,
        step: TransferDraftStep.AWAITING_LABEL_SELECTION,
      },
    });
    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      `found it, ${resolved.accountName}. how should I tag this recipient?`,
      "Tag recipient",
      LABEL_ROWS,
      user.id,
    );
  }

  /** Hands off to TransferConfirmationService, which sends the fee/confirm-cancel buttons — the wizard's job is done once this is called. */
  private async finalizeTransfer(
    user: User,
    draft: TransferDraft,
    recipientLabel: RecipientLabel,
    options?: {
      purposeLabel?: RecipientLabel;
      beneficiaryNickname?: string;
    },
  ): Promise<void> {
    if (!draft.amount || !draft.accountNumber || !draft.bankCode) {
      this.logger.error(
        `finalizeTransfer called with an incomplete draft ${draft.id}`,
      );
      return;
    }

    await this.prisma.transferDraft.update({
      where: { id: draft.id },
      data: { status: TransferDraftStatus.COMPLETED, label: recipientLabel },
    });

    await this.transferConfirmation.initiateTransfer({
      userId: user.id,
      accountNumber: draft.accountNumber,
      bankCode: draft.bankCode,
      amount: Number(draft.amount),
      resolvedName: draft.resolvedName ?? undefined,
      label: recipientLabel,
      purposeLabel:
        options?.purposeLabel ?? draft.label ?? recipientLabel,
      beneficiaryNickname: options?.beneficiaryNickname,
    });
  }

  private async resolveBeneficiaryHints(
    user: User,
    hints: TransferWizardHints,
  ): Promise<TransferWizardHints | "disambiguation_sent"> {
    if (
      hints.accountNumber ||
      hints.bankCode ||
      hints.bankName ||
      !hints.beneficiaryName
    ) {
      return hints;
    }

    const query = hints.beneficiaryName;
    const unique = await this.tagging.matchBeneficiaryByName(user.id, query);
    if (unique) {
      return {
        ...hints,
        accountNumber: unique.accountNumber,
        bankCode: unique.bankCode,
      };
    }

    const ambiguous = await this.tagging.findAmbiguousBeneficiaryMatches(
      user.id,
      query,
    );
    if (ambiguous.length <= 1) {
      return hints;
    }

    await this.writeBeneficiaryPick(user.id, hints);
    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      `which ${query} did you mean?`,
      "Pick recipient",
      ambiguous.slice(0, 10).map((r) => ({
        id: `${BENEFICIARY_BUTTON_PREFIX}${r.id}`,
        title: (r.nickname ?? r.accountName ?? r.accountNumber).slice(0, 24),
        description: `${r.accountNumber} · ${r.label.toLowerCase()}`,
      })),
      user.id,
    );
    return "disambiguation_sent";
  }

  private async writeBeneficiaryPick(
    userId: string,
    hints: TransferWizardHints,
  ): Promise<void> {
    const session = await this.getOrCreateKeduSession(userId);
    const ctx = this.sessionContext(session);
    ctx.beneficiaryPick = hints;
    await this.prisma.conversationSession.update({
      where: { id: session.id },
      data: { contextData: ctx as Prisma.InputJsonValue },
    });
  }

  private async readBeneficiaryPick(
    userId: string,
  ): Promise<{ hints: TransferWizardHints } | null> {
    const session = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!session) return null;
    const raw = this.sessionContext(session).beneficiaryPick;
    if (!raw || typeof raw !== "object") return null;
    return { hints: raw as TransferWizardHints };
  }

  private async clearBeneficiaryPick(userId: string): Promise<void> {
    const session = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!session) return;
    const ctx = this.sessionContext(session);
    delete ctx.beneficiaryPick;
    await this.prisma.conversationSession.update({
      where: { id: session.id },
      data: { contextData: ctx as Prisma.InputJsonValue },
    });
  }

  private sessionContext(session: {
    contextData: Prisma.JsonValue;
  }): Record<string, unknown> {
    const raw = session.contextData;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  }

  private async getOrCreateKeduSession(userId: string) {
    const existing = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (existing) return existing;
    return this.prisma.conversationSession.create({
      data: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
        messages: [],
      },
    });
  }
}
