import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { RubiesService } from "../rubies/rubies.service";
import { TaggingService } from "../tagging/tagging.service";
import { WhatsappService } from "./whatsapp.service";
import {
  OnboardingStage,
  RecipientLabel,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import { TransactionType as LocalTransactionType } from "../common/enums/transaction-type.enum";

export const CONFIRM_BUTTON_PREFIX = "confirm_transfer:";
export const CANCEL_BUTTON_PREFIX = "cancel_transfer:";

/**
 * The confirm-before-transfer flow (PRD §5's pre-transfer confirmation, §4a):
 * evaluateSpend -> tag/confirm recipient -> confirm buttons -> initiateTransfer
 * -> recordSpend. Deterministic end to end — the only "intent" input this
 * needs (recipient + amount) currently comes from a structured text command
 * (see parsers/text-command.parser.ts) rather than free-text classification,
 * since the AI layer (Phase 3) is deferred; nothing below depends on that
 * being true, so swapping in real classification later only changes what
 * calls initiateTransfer, not this service.
 *
 * New-recipient simplification (documented, not silent): WhatsApp's button
 * message type allows at most 3 buttons, but there are 4 recipient labels
 * (RENT/FOOD/VENDOR/OTHER) — rather than build a second interactive-list
 * round-trip just for labeling, new recipients are auto-tagged OTHER and the
 * confirmation message says so. Re-labeling isn't built (needs a command/UI
 * this plan doesn't otherwise have a natural home for yet).
 */
@Injectable()
export class TransferConfirmationService {
  private readonly logger = new Logger(TransferConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly tagging: TaggingService,
    private readonly whatsapp: WhatsappService,
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
        "You don't have a Kedu account set up yet, so there's nothing to send from.",
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
          `Couldn't verify account ${params.accountNumber} at that bank — double-check the account number and bank code.`,
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
    if (evaluation.feeAmount > 0) {
      bodyLines.push(
        `${evaluation.type} fee: ₦${evaluation.feeAmount.toLocaleString("en-NG")}${evaluation.waived ? " (waived)" : ""}`,
      );
    } else if (evaluation.type !== LocalTransactionType.NORMAL) {
      bodyLines.push(`${evaluation.type} — fee waived by yesterday's surplus`);
    }
    bodyLines.push(
      `Remaining today after this: ₦${(evaluation.remainingToday - params.amount).toLocaleString("en-NG")}`,
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

    const { user, recipient } = transaction;
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
        `That transfer needs ₦${totalCost.toLocaleString("en-NG")} but your Kedu account only has ₦${balance.toLocaleString("en-NG")}. Cancelled.`,
        user.id,
      );
      return;
    }

    // Marks the button-tap as acted-on before calling Rubies — a second concurrent
    // tap of the same button hits the PENDING_CONFIRMATION guard above, not this path.
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
      narration: `Kedu transfer to ${recipient.accountName ?? recipient.accountNumber}`,
      idempotencyKey: transaction.idempotencyKey ?? randomUUID(),
    });

    if (result.status === "PENDING") {
      // Stays CONFIRMED — the Rubies webhook (Phase 7) or the reconciliation
      // scheduler below will resolve this to EXECUTED/FAILED once known.
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "Your transfer is processing — I'll confirm once it's done.",
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
      "Cancelled — nothing was sent.",
      transaction.user.id,
    );
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
      await this.allowance.recordSpend(transaction.id);

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
          `Done — ₦${Number(transaction.amount).toLocaleString("en-NG")} sent to ${transaction.recipient.accountName ?? transaction.recipient.accountNumber}.`,
          transaction.user.id,
        );
      }
    } else {
      await this.whatsapp.sendText(
        transaction.user.whatsappNumber,
        "That transfer failed on Rubies' end — nothing was deducted from today's allowance.",
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
}
