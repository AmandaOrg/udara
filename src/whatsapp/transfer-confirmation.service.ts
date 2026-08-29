import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { RubiesService, RUBIES_MFB_BANK_CODE } from "../rubies/rubies.service";
import { TaggingService } from "../tagging/tagging.service";
import { WhatsappService } from "./whatsapp.service";
import { PinGateService } from "./pin-gate.service";
import { EmailNotificationsService } from "../email/email-notifications.service";
import {
  ConversationPersona,
  ConversationSessionStatus,
  OnboardingStage,
  Prisma,
  RecipientLabel,
  Transaction,
  TransactionStatus,
  TransactionType,
  TransferDraftStatus,
  User,
} from "@prisma/client";
import { TransactionType as LocalTransactionType } from "../common/enums/transaction-type.enum";

export const CONFIRM_BUTTON_PREFIX = "confirm_transfer:";
export const CANCEL_BUTTON_PREFIX = "cancel_transfer:";

/** User-facing label for spend classification on confirm buttons. */
export function formatSpendTypeLabel(
  type: LocalTransactionType,
  feeAmount: number,
  waived: boolean,
): string | null {
  if (type === LocalTransactionType.NORMAL) return null;
  if (type === LocalTransactionType.EARLY_ACCESS) {
    return waived
      ? "outside spending window (fee waived)"
      : "outside spending window";
  }
  if (type === LocalTransactionType.BORROWED) {
    return waived
      ? "borrowing from future allowance (fee waived)"
      : "borrowing from future allowance";
  }
  return null;
}

/** Fee line for confirm UI — omits raw enum names. */
export function formatSpendFeeLine(
  type: LocalTransactionType,
  feeAmount: number,
  waived: boolean,
): string | null {
  const label = formatSpendTypeLabel(type, feeAmount, waived);
  if (!label) return null;
  if (feeAmount > 0) {
    return `${label} fee: ₦${feeAmount.toLocaleString("en-NG")}${waived ? " (waived)" : ""}`;
  }
  if (waived && type === LocalTransactionType.BORROWED) {
    return `${label}: fee waived by yesterday's surplus`;
  }
  return label;
}

/**
 * The confirm-before-transfer flow (PRD §5's pre-transfer confirmation, §4a):
 * evaluateSpend -> tag/confirm recipient -> confirm buttons -> initiateTransfer
 * -> recordSpend. Deterministic end to end. Recipient labeling comes either
 * from AccountActionsService's interactive send-money wizard (a real tap-to-
 * pick list — see account-actions.service.ts) or defaults to OTHER for the
 * legacy "send <amount> to <account> <bank>" text-command shortcut, which
 * doesn't collect a label.
 */
@Injectable()
export class TransferConfirmationService {
  private readonly logger = new Logger(TransferConfirmationService.name);

  // In-memory only — re-resolved on process restart. The fees account's
  // registered name rarely if ever changes, and a resolution failure falls
  // back to a generic label rather than blocking the sweep (see
  // sweepFeeToFeesAccount) — a stale/fallback name here is cosmetic only,
  // it doesn't affect where the money actually goes.
  private feesAccountNameCache: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly tagging: TaggingService,
    private readonly whatsapp: WhatsappService,
    private readonly pinGate: PinGateService,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  async initiateTransfer(params: {
    userId: string;
    accountNumber: string;
    bankCode: string;
    amount: number;
    // Set by the interactive send-money wizard (account-actions.service.ts),
    // which already ran name-enquiry and — for a new recipient — asked the
    // user to pick a label via a list message. When set, skip the internal
    // name-enquiry call (avoid double-hitting Rubies) and use the given
    // label instead of defaulting to OTHER. Unset for the legacy
    // "send <amount> to <account> <bank>" text-command shortcut, which
    // preserves its original auto-tag-OTHER behavior exactly.
    resolvedName?: string;
    label?: RecipientLabel;
  }): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.userId },
    });

    if (!user.rubiesAccountNumber || !user.rubiesAccountName) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account set up yet, so there's nothing to send from.",
        user.id,
      );
      return;
    }

    // The classification itself (NORMAL/EARLY_ACCESS/BORROWED) and its fee stay
    // 100% deterministic — evaluateSpend never touches an LLM, by design.
    const evaluation = await this.allowance.evaluateSpend(
      params.userId,
      params.amount,
    );

    let recipient = await this.tagging.findRecipient(
      params.userId,
      params.accountNumber,
      params.bankCode,
    );
    let isNewRecipient = false;
    if (!recipient) {
      isNewRecipient = true;
      const resolvedName =
        params.resolvedName ??
        (await this.rubies
          .nameEnquiry({
            accountNumber: params.accountNumber,
            bankCode: params.bankCode,
          })
          .then((r) => r.accountName)
          .catch(() => null));
      if (!resolvedName) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          `Couldn't verify account ${params.accountNumber} at that bank, double-check the account number and bank code.`,
          user.id,
        );
        return;
      }
      recipient = await this.tagging.tagRecipient({
        userId: params.userId,
        accountNumber: params.accountNumber,
        bankCode: params.bankCode,
        accountName: resolvedName,
        label: params.label ?? RecipientLabel.OTHER,
      });
    }

    const idempotencyKey = randomUUID();
    const transaction = await this.prisma.transaction.create({
      data: {
        userId: params.userId,
        recipientId: recipient.id,
        amount: params.amount,
        type: evaluation.type as unknown as TransactionType,
        status: TransactionStatus.PENDING_CONFIRMATION,
        feeAmount: evaluation.feeAmount,
        idempotencyKey,
      },
    });

    const bodyLines = [
      isNewRecipient
        ? `New recipient: ${recipient.accountName ?? recipient.accountNumber} (tagged "${recipient.label.toLowerCase()}").`
        : `Send to ${recipient.accountName ?? recipient.accountNumber}?`,
      `Amount: ₦${params.amount.toLocaleString("en-NG")}`,
    ];
    const feeLine = formatSpendFeeLine(
      evaluation.type as LocalTransactionType,
      evaluation.feeAmount,
      evaluation.waived,
    );
    if (feeLine) {
      bodyLines.push(feeLine);
    }

    // Live wallet balance — separate from daily allowance so the confirm
    // screen matches what users expect (₦1000 balance − ₦800 = ₦200 left).
    if (user.rubiesAccountNumber) {
      const balance = await this.rubies
        .getBalance(user.rubiesAccountNumber)
        .catch(() => null);
      if (balance !== null) {
        const afterBalance = balance - params.amount - evaluation.feeAmount;
        bodyLines.push(
          `Account balance after this: ₦${Math.max(0, afterBalance).toLocaleString("en-NG")}`,
        );
      }
    }

    bodyLines.push(
      `Allowance left today after this: ₦${Math.max(0, evaluation.remainingToday - params.amount).toLocaleString("en-NG")}`,
    );

    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      bodyLines.join("\n"),
      [
        { id: `${CONFIRM_BUTTON_PREFIX}${transaction.id}`, title: "Confirm" },
        { id: `${CANCEL_BUTTON_PREFIX}${transaction.id}`, title: "Cancel" },
      ],
      user.id,
    );
  }

  async confirmTransfer(transactionId: string): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { recipient: true, user: true },
    });
    if (!transaction) {
      this.logger.warn(`confirmTransfer: no such transaction ${transactionId}`);
      return;
    }
    if (transaction.status !== TransactionStatus.PENDING_CONFIRMATION) {
      // Already actioned (double-tap, or a redelivered button webhook) — no-op.
      return;
    }

    // Only `user` here: the recipient is needed when the transfer actually
    // executes, which now happens in executeVerifiedTransfer after the PIN.
    const { user } = transaction;
    if (!user.rubiesAccountNumber || !user.rubiesAccountName) {
      throw new BadRequestException(
        `User ${user.id} has no Rubies account to send from`,
      );
    }

    // Never trust a locally-cached balance — a live check right before authorizing.
    const balance = await this.rubies.getBalance(user.rubiesAccountNumber);
    const totalCost =
      Number(transaction.amount) + Number(transaction.feeAmount);
    if (balance < totalCost) {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.FAILED },
      });
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `That transfer needs ₦${totalCost.toLocaleString("en-NG")} but your Udara account only has ₦${balance.toLocaleString("en-NG")}. Cancelled.`,
        user.id,
      );
      return;
    }

    // First transfer ever, no PIN on file: set one before anything moves.
    // The transaction stays PENDING_CONFIRMATION so the user can tap Confirm
    // again once their PIN exists, rather than silently losing the transfer.
    if (!user.pinHash) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "before your first transfer, you need to set a 4-digit pin. you'll use it to approve every transfer from here on.",
        user.id,
      );
      await this.pinGate.requestPinSetup(user);
      return;
    }

    // Locked out from earlier wrong attempts: refuse now rather than opening
    // a challenge that cannot succeed.
    if (this.pinGate.isLocked(user)) {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.CANCELLED },
      });
      await this.pinGate.notifyLocked(user);
      return;
    }

    // All pre-flight guards have passed, but money does NOT move here. The
    // transfer now needs a PIN: moving to PENDING_PIN also closes the
    // PENDING_CONFIRMATION guard above, so a second tap of the confirm button
    // can't open a second challenge for the same transaction.
    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: TransactionStatus.PENDING_PIN },
    });
    await this.pinGate.requestTransferPin(user, transaction.id);
  }

  /**
   * After first-time PIN setup, continue the transfer the user already confirmed
   * (they should get the enter-PIN flow, not a blank wizard).
   */
  async resumeAfterPinSetup(userId: string): Promise<void> {
    const pending = await this.prisma.transaction.findFirst({
      where: {
        userId,
        status: {
          in: [
            TransactionStatus.PENDING_CONFIRMATION,
            TransactionStatus.PENDING_PIN,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });
    if (!pending) return;

    if (pending.status === TransactionStatus.PENDING_PIN) {
      await this.pinGate.requestTransferPin(pending.user, pending.id);
      return;
    }

    await this.whatsapp.sendText(
      pending.user.whatsappNumber,
      "now enter your PIN to send that transfer.",
      pending.user.id,
    );
    await this.confirmTransfer(pending.id);
  }

  /**
   * If a confirm or PIN step is already in flight, resume it instead of
   * starting a new send-money wizard from scratch.
   */
  async resumePendingTransferUi(user: User): Promise<boolean> {
    const pending = await this.prisma.transaction.findFirst({
      where: {
        userId: user.id,
        status: {
          in: [
            TransactionStatus.PENDING_CONFIRMATION,
            TransactionStatus.PENDING_PIN,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      include: { recipient: true, user: true },
    });
    if (!pending) return false;

    if (pending.status === TransactionStatus.PENDING_PIN) {
      await this.pinGate.requestTransferPin(user, pending.id);
      return true;
    }

    await this.confirmTransfer(pending.id);
    return true;
  }

  /**
   * Executes a transfer whose PIN has already been verified. Private and
   * called from exactly one place (PinGateService, after consuming a valid
   * single-use challenge bound to this transaction id) — that is what makes
   * "no PIN, no Rubies call" a structural property rather than a convention.
   *
   * The body below is unchanged from what confirmTransfer used to do inline;
   * only the entry condition is new.
   */
  async executeVerifiedTransfer(transactionId: string): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { recipient: true, user: true },
    });
    if (!transaction) {
      this.logger.warn(
        `executeVerifiedTransfer: no such transaction ${transactionId}`,
      );
      return;
    }
    if (transaction.status !== TransactionStatus.PENDING_PIN) {
      // Already actioned, or reached without going through the PIN gate.
      this.logger.warn(
        `executeVerifiedTransfer: transaction ${transactionId} is ${transaction.status}, not PENDING_PIN — refusing`,
      );
      return;
    }

    const { user, recipient } = transaction;
    if (!user.rubiesAccountNumber || !user.rubiesAccountName) {
      throw new BadRequestException(
        `User ${user.id} has no Rubies account to send from`,
      );
    }

    // Marks the transaction as acted-on before calling Rubies — a second
    // concurrent execution hits the PENDING_PIN guard above, not this path.
    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
    });

    const result = await this.rubies.initiateTransfer({
      fromAccountNumber: user.rubiesAccountNumber,
      fromAccountName: user.rubiesAccountName,
      toAccountNumber: recipient.accountNumber,
      toBankCode: recipient.bankCode,
      toAccountName: recipient.accountName ?? recipient.accountNumber,
      amount: Number(transaction.amount),
      narration: `Udara transfer to ${recipient.accountName ?? recipient.accountNumber}`,
      idempotencyKey: transaction.idempotencyKey ?? randomUUID(),
    });

    if (result.status === "PENDING") {
      // Stays CONFIRMED — the Rubies webhook (Phase 7) or the reconciliation
      // scheduler below will resolve this to EXECUTED/FAILED once known.
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "Your transfer is processing, I'll confirm once it's done.",
        user.id,
      );
      return;
    }

    await this.applyTransferResult(
      transaction.id,
      result.status,
      result.reference,
    );
  }

  async cancelTransfer(transactionId: string): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });
    if (
      !transaction ||
      transaction.status !== TransactionStatus.PENDING_CONFIRMATION
    )
      return;

    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { status: TransactionStatus.CANCELLED },
    });
    await this.whatsapp.sendText(
      transaction.user.whatsappNumber,
      "Cancelled, nothing was sent.",
      transaction.user.id,
    );
  }

  /** Cancels all PENDING_CONFIRMATION transfers for a user (orchestrator cancel_surface). */
  async cancelPendingForUser(
    userId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const pending = await this.prisma.transaction.findMany({
      where: {
        userId,
        status: TransactionStatus.PENDING_CONFIRMATION,
      },
      include: { user: true },
    });
    for (const transaction of pending) {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: TransactionStatus.CANCELLED },
      });
      if (!options?.silent) {
        await this.whatsapp.sendText(
          transaction.user.whatsappNumber,
          "Cancelled, nothing was sent.",
          transaction.user.id,
        );
      }
    }
  }

  /**
   * Shared by confirmTransfer's synchronous SUCCESS/FAILED path and the
   * reconciliation scheduler (for transactions that came back PENDING and
   * only resolved later). Idempotent at the status-update level: re-applying
   * the same terminal status is a no-op via AllowanceService.recordSpend's
   * own idempotency guard.
   */
  async applyTransferResult(
    transactionId: string,
    status: "SUCCESS" | "FAILED",
    rubiesReference?: string,
  ): Promise<void> {
    const transaction = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { user: true, recipient: true },
    });

    if (
      transaction.status === TransactionStatus.EXECUTED ||
      transaction.status === TransactionStatus.FAILED
    ) {
      return; // already resolved
    }

    const newStatus =
      status === "SUCCESS"
        ? TransactionStatus.EXECUTED
        : TransactionStatus.FAILED;
    await this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: newStatus,
        rubiesReference,
        executedAt:
          newStatus === TransactionStatus.EXECUTED ? new Date() : undefined,
      },
    });

    if (newStatus === TransactionStatus.EXECUTED) {
      if (transaction.type !== TransactionType.NORMAL) {
        await this.prisma.overrideHistory.create({
          data: {
            userId: transaction.userId,
            transactionId: transaction.id,
            type: transaction.type,
            feeAmount: transaction.feeAmount,
            waived: Number(transaction.feeAmount) === 0,
          },
        });
      }
      // Best-effort: never let a fee-sweep problem affect the transaction
      // the user already saw succeed — see sweepFeeToFeesAccount.
      await this.sweepFeeToFeesAccount(transaction, transaction.user);
      await this.allowance.recordSpend(transaction.id);
      await this.prisma.transferDraft.updateMany({
        where: {
          userId: transaction.userId,
          status: TransferDraftStatus.ACTIVE,
        },
        data: { status: TransferDraftStatus.CANCELLED },
      });
      await this.recordCompletedTransferInChat(transaction);

      // Best-effort, keyed on the transaction id so the webhook path and the
      // reconciliation scheduler can't both send for the same transfer.
      await this.emailNotifications.sendMoneyOut({
        user: transaction.user,
        transactionId: transaction.id,
        amount: Number(transaction.amount),
        feeAmount: Number(transaction.feeAmount),
        recipientName:
          transaction.recipient.accountName ??
          transaction.recipient.accountNumber,
        recipientAccount: transaction.recipient.accountNumber,
      });

      const isFirstTransactionOfOnboarding =
        transaction.user.onboardingStage === OnboardingStage.ACCOUNT_CREATED ||
        transaction.user.onboardingStage === OnboardingStage.FUNDED;

      if (isFirstTransactionOfOnboarding) {
        await this.completeOnboardingAfterFirstTransaction(
          transaction.userId,
          transaction.user.whatsappNumber,
        );
      } else {
        await this.whatsapp.sendText(
          transaction.user.whatsappNumber,
          `Done, ₦${Number(transaction.amount).toLocaleString("en-NG")} sent to ${transaction.recipient.accountName ?? transaction.recipient.accountNumber}.`,
          transaction.user.id,
        );
      }
    } else {
      await this.whatsapp.sendText(
        transaction.user.whatsappNumber,
        "That transfer failed on Rubies' end, nothing was deducted from today's allowance.",
        transaction.user.id,
      );
    }
  }

  /**
   * Onboarding script Stage 12 (First Transaction) -> Stage 13 (Habit-Forming
   * Follow-Up, sent ~10h later by AllowanceScheduler). FUNDED/ACCOUNT_CREATED
   * users skip straight to COMPLETE here rather than persisting a distinct
   * FIRST_TRANSACTION row — nothing else in the app branches on that
   * intermediate value, and the transition is instantaneous in practice.
   */
  private async completeOnboardingAfterFirstTransaction(
    userId: string,
    whatsappNumber: string,
  ): Promise<void> {
    const allowance = await this.allowance.getOrCreateTodayAllowance(userId);
    const remainingToday =
      Number(allowance.amountAllocated) +
      Number(allowance.surplusCarriedIn) -
      Number(allowance.amountSpent);

    const weekRows = await this.prisma.dailyAllowance.findMany({
      where: { userId, weekStartDate: allowance.weekStartDate },
    });
    const remainingWeek = weekRows.reduce(
      (sum, row) =>
        sum +
        Number(row.amountAllocated) +
        Number(row.surplusCarriedIn) -
        Number(row.amountSpent),
      0,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStage: OnboardingStage.COMPLETE,
        onboardingCompletedAt: new Date(),
      },
    });

    const text = [
      "payment successful ✅",
      `remaining today: ₦${remainingToday.toLocaleString("en-NG")}`,
      `remaining this week: ₦${remainingWeek.toLocaleString("en-NG")}`,
      "keep going.",
    ].join("\n\n");
    await this.whatsapp.sendText(whatsappNumber, text, userId);
  }

  /**
   * Sweeps a transaction's override fee (if any) to a dedicated Rubies
   * "fees account" — configured via RUBIES_FEES_ACCOUNT_NUMBER — so Udara
   * actually collects the early-access/borrow fee it charges, rather than
   * only ever tracking it in OverrideHistory without the money moving
   * anywhere. Best-effort: a failure here is logged loudly but never
   * affects the transaction the user already saw succeed.
   *
   * Not fully reconciled if the sweep itself comes back PENDING or fails:
   * unlike the main transfer, there's no confirm-button/webhook/
   * reconciliation-scheduler infrastructure wired specifically for this
   * secondary transfer yet — feeSweepReference is still recorded either way
   * so a stuck sweep can be found and retried manually; feeSweptAt (the
   * "definitely collected" signal, and this method's idempotency guard) is
   * only set once Rubies confirms SUCCESS.
   */
  private async sweepFeeToFeesAccount(
    transaction: Transaction,
    user: Pick<User, "id" | "rubiesAccountNumber" | "rubiesAccountName">,
  ): Promise<void> {
    const feeAmount = Number(transaction.feeAmount);
    if (feeAmount <= 0 || transaction.feeSweptAt) return;

    const feesAccountNumber = this.config.get<string>(
      "RUBIES_FEES_ACCOUNT_NUMBER",
    );
    if (!feesAccountNumber) {
      this.logger.warn(
        `RUBIES_FEES_ACCOUNT_NUMBER is not set — skipping ₦${feeAmount} fee sweep for transaction ${transaction.id}`,
      );
      return;
    }
    if (!user.rubiesAccountNumber || !user.rubiesAccountName) {
      this.logger.error(
        `Cannot sweep fee for transaction ${transaction.id} — user ${user.id} has no Rubies account`,
      );
      return;
    }

    const feesBankCode = this.config.get<string>(
      "RUBIES_FEES_BANK_CODE",
      RUBIES_MFB_BANK_CODE,
    );

    try {
      const feesAccountName = await this.resolveFeesAccountName(
        feesAccountNumber,
        feesBankCode,
      );
      const result = await this.rubies.initiateTransfer({
        fromAccountNumber: user.rubiesAccountNumber,
        fromAccountName: user.rubiesAccountName,
        toAccountNumber: feesAccountNumber,
        toBankCode: feesBankCode,
        toAccountName: feesAccountName,
        amount: feeAmount,
        narration: `Udara ${transaction.type.toLowerCase()} fee`,
        // Deliberately distinct from the main transfer's idempotencyKey so
        // Rubies (and our own dedup) tracks the two transfers independently.
        idempotencyKey: `${transaction.idempotencyKey ?? transaction.id}-fee`,
      });

      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          feeSweepReference: result.reference,
          feeSweptAt: result.status === "SUCCESS" ? new Date() : undefined,
        },
      });

      if (result.status !== "SUCCESS") {
        this.logger.warn(
          `Fee sweep for transaction ${transaction.id} came back ${result.status} — not marked as swept, needs manual reconciliation if it never resolves`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to sweep ₦${feeAmount} fee for transaction ${transaction.id} to the fees account: ${String(err)}`,
      );
    }
  }

  /**
   * Resolved once via name-enquiry and cached for the life of the process —
   * the fees account's registered name essentially never changes. Falls
   * back to a generic label rather than blocking the sweep if the lookup
   * itself fails; the fallback only affects a cosmetic display field on the
   * Rubies side, not where the money goes.
   */
  private async resolveFeesAccountName(
    accountNumber: string,
    bankCode: string,
  ): Promise<string> {
    if (this.feesAccountNameCache) return this.feesAccountNameCache;

    const resolved = await this.rubies
      .nameEnquiry({ accountNumber, bankCode })
      .catch(() => null);
    this.feesAccountNameCache = resolved?.accountName ?? "Udara Fees";
    return this.feesAccountNameCache;
  }

  /**
   * Wizard/confirm/success never go through the orchestrator, so they were
   * invisible in chat history. Write a one-line fact so "thank you" cannot
   * restart the same send.
   */
  private async recordCompletedTransferInChat(
    transaction: Transaction & {
      recipient?: { accountName: string | null; accountNumber: string } | null;
    },
  ): Promise<void> {
    const who =
      transaction.recipient?.accountName ??
      transaction.recipient?.accountNumber ??
      "the recipient";
    const line = `System: ₦${Number(transaction.amount).toLocaleString("en-NG")} to ${who} succeeded. Do not start that transfer again.`;
    try {
      const session = await this.prisma.conversationSession.findFirst({
        where: {
          userId: transaction.userId,
          persona: ConversationPersona.KEDU,
          status: ConversationSessionStatus.ACTIVE,
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!session) return;
      const messages = Array.isArray(session.messages)
        ? [...(session.messages as object[])]
        : [];
      messages.push({
        role: "assistant",
        content: line,
        at: new Date().toISOString(),
      });
      await this.prisma.conversationSession.update({
        where: { id: session.id },
        data: { messages: messages as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(
        `Could not record completed transfer in chat for user ${transaction.userId}: ${String(err)}`,
      );
    }
  }
}
