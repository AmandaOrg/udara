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

/**
 * Past this, a pending transfer is re-quoted before it can execute, so nothing
 * moves on figures the customer saw a long time ago. Not a hard expiry: killing
 * the row would break resumePendingTransferUi and resumeAfterPinSetup, both of
 * which exist precisely to resume an old confirm.
 */
const CONFIRM_RE_QUOTE_AFTER_MS = 10 * 60 * 1000;

/** How long a sweep attempt holds the row before another caller may retry it. */
const FEE_SWEEP_LEASE_MS = 5 * 60 * 1000;
/** After this many tries the fee is an ops problem, not a retry problem. */
const FEE_SWEEP_MAX_ATTEMPTS = 5;
/**
 * Stop retrying after a day. The fee comes out of the customer's own wallet, so
 * a late sweep is a surprise debit against money they have already spent.
 */
const FEE_SWEEP_GIVE_UP_MS = 24 * 60 * 60 * 1000;

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
    /** Spend purpose for this send (from spend-check / orchestrator), not recipient tag. */
    purposeLabel?: RecipientLabel;
    /** Free-text purpose when the category is OTHER. */
    purposeNote?: string;
    /** Nickname to persist when this send succeeds (from beneficiary_name hint). */
    beneficiaryNickname?: string;
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
        nickname: params.beneficiaryNickname,
      });
    } else if (params.beneficiaryNickname) {
      await this.tagging.touchRecipientUsed(recipient.id, {
        nickname: params.beneficiaryNickname,
      });
    }

    const purposeLabel =
      params.purposeLabel ?? params.label ?? RecipientLabel.OTHER;
    const idempotencyKey = randomUUID();
    const transaction = await this.prisma.transaction.create({
      data: {
        userId: params.userId,
        recipientId: recipient.id,
        amount: params.amount,
        type: evaluation.type as unknown as TransactionType,
        status: TransactionStatus.PENDING_CONFIRMATION,
        feeAmount: evaluation.feeAmount,
        purposeLabel,
        purposeNote: params.purposeNote?.trim().slice(0, 200) || undefined,
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
    // A Rubies blip here used to throw all the way out to the controller, which
    // logged it and marked the message FAILED, so the user tapped Confirm and got
    // literal silence. The row is untouched at this point, so the Confirm button in
    // chat is still live: tell them to tap it again.
    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch((err) => {
        this.logger.warn(
          `confirmTransfer: balance check failed for ${transaction.id}: ${String(err)}`,
        );
        return null;
      });
    if (balance === null) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "i couldn't check your balance just now. tap confirm again in a moment.",
        user.id,
      );
      return;
    }
    const totalCost =
      Number(transaction.amount) + Number(transaction.feeAmount);
    if (balance < totalCost) {
      const failed = await this.claimStatus(
        transaction.id,
        TransactionStatus.PENDING_CONFIRMATION,
        { status: TransactionStatus.FAILED },
      );
      if (!failed) return;
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `That transfer needs ₦${totalCost.toLocaleString("en-NG")} but your Udara account only has ₦${balance.toLocaleString("en-NG")}. Cancelled.`,
        user.id,
      );
      return;
    }

    // The spend type and fee were frozen when the transfer was proposed and were
    // never re-checked, so a user could sit on the Confirm button until the
    // spending window closed and still send at the old zero-fee terms, or stack
    // several sends that each fitted the allowance when proposed.
    //
    // Re-quote rather than hard-fail. An age limit that simply killed the row
    // would break the two paths whose whole job is resuming an old confirm:
    // resumePendingTransferUi, and resumeAfterPinSetup after a first-time PIN
    // choice. Nothing executes on terms older than the limit without a fresh
    // tap, and the customer always sees the figures they are authorising.
    const stale =
      Date.now() - transaction.createdAt.getTime() > CONFIRM_RE_QUOTE_AFTER_MS;
    const fresh = await this.allowance.evaluateSpend(
      transaction.userId,
      Number(transaction.amount),
    );
    const termsChanged =
      fresh.type !== (transaction.type as unknown as LocalTransactionType) ||
      fresh.feeAmount !== Number(transaction.feeAmount);

    if (stale || termsChanged) {
      await this.prisma.transaction.updateMany({
        where: {
          id: transaction.id,
          status: TransactionStatus.PENDING_CONFIRMATION,
        },
        data: {
          type: fresh.type as unknown as TransactionType,
          feeAmount: fresh.feeAmount,
        },
      });
      await this.sendConfirmationRequest(
        { ...transaction, type: fresh.type as unknown as TransactionType },
        user,
        fresh,
        balance,
        termsChanged,
      );
      return; // stays PENDING_CONFIRMATION — the user re-authorises what they can see
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
      const cancelled = await this.claimStatus(
        transaction.id,
        TransactionStatus.PENDING_CONFIRMATION,
        { status: TransactionStatus.CANCELLED },
      );
      if (!cancelled) return;
      await this.pinGate.notifyLocked(user);
      return;
    }

    // All pre-flight guards have passed, but money does NOT move here. The
    // transfer now needs a PIN. The status read at the top of this method is a
    // snapshot from before a live balance HTTP call, so it cannot be the guard:
    // two Confirm taps arrive as two concurrent webhooks and both would reach
    // here, minting two PIN challenges for one transaction. Claiming the
    // transition is what makes the second tap a no-op.
    const claimed = await this.claimStatus(
      transaction.id,
      TransactionStatus.PENDING_CONFIRMATION,
      { status: TransactionStatus.PENDING_PIN },
    );
    if (!claimed) return;
    await this.pinGate.requestTransferPin(user, transaction.id);
  }

  /**
   * Re-renders the Confirm/Cancel buttons with current terms, for a transfer
   * whose fee or spend type moved while it sat unconfirmed, or which simply sat
   * too long. Deliberately does not touch the status: the row stays
   * PENDING_CONFIRMATION and the customer authorises the figures in front of
   * them, rather than the ones they saw before the window closed.
   */
  private async sendConfirmationRequest(
    transaction: Pick<Transaction, "id" | "amount" | "type">,
    user: User,
    evaluation: {
      type: LocalTransactionType;
      feeAmount: number;
      waived: boolean;
      remainingToday: number;
    },
    balance: number,
    termsChanged: boolean,
  ): Promise<void> {
    const amount = Number(transaction.amount);
    const lines = [
      termsChanged
        ? "the terms on this one moved while it was waiting, so here it is again:"
        : "this has been waiting a while, so let's confirm it again:",
      `Amount: ₦${amount.toLocaleString("en-NG")}`,
    ];

    const feeLine = formatSpendFeeLine(
      evaluation.type,
      evaluation.feeAmount,
      evaluation.waived,
    );
    if (feeLine) lines.push(feeLine);

    lines.push(
      `Account balance after this: ₦${Math.max(0, balance - amount - evaluation.feeAmount).toLocaleString("en-NG")}`,
      `Allowance left today after this: ₦${Math.max(0, evaluation.remainingToday - amount).toLocaleString("en-NG")}`,
    );

    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      lines.join("\n"),
      [
        { id: `${CONFIRM_BUTTON_PREFIX}${transaction.id}`, title: "Confirm" },
        { id: `${CANCEL_BUTTON_PREFIX}${transaction.id}`, title: "Cancel" },
      ],
      user.id,
    );
  }

  /**
   * Moves a transaction from one status to another, atomically, and reports
   * whether this caller is the one that did it.
   *
   * Every money-state transition has to go through here. A read-then-write
   * (`findUnique`, check `status`, `update`) looks safe but is not: the
   * controller acks the webhook and then processes, so two taps of the same
   * button are two concurrent executions, and each one's status check happens
   * before the other's write. The loser must do nothing, not repeat the work.
   *
   * Modelled on PinService.consumeChallenge, which already does this for the
   * single-use PIN token.
   */
  private async claimStatus(
    transactionId: string,
    from: TransactionStatus,
    data: Prisma.TransactionUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: from },
      data,
    });
    if (count === 0) {
      this.logger.warn(
        `transaction ${transactionId} was not in ${from} — another handler claimed it first`,
      );
      return false;
    }
    return true;
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

    // The single most important claim in this service. Multiple valid PIN
    // challenges can exist for one transaction by design — confirmTransfer mints
    // one, every wrong-PIN retry mints another, and resumePendingTransferUi mints
    // one more — and consumeChallenge is single-use *per token*, so N tokens can
    // yield N valid execute outcomes. The status read above is a snapshot, so
    // without this claim two of them both reach Rubies with the same
    // idempotencyKey, and only Rubies-side reference dedup (which nothing here
    // verifies) stands between that and debiting the customer twice.
    const claimed = await this.claimStatus(
      transaction.id,
      TransactionStatus.PENDING_PIN,
      { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
    );
    if (!claimed) return;

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

    const cancelled = await this.claimStatus(
      transactionId,
      TransactionStatus.PENDING_CONFIRMATION,
      { status: TransactionStatus.CANCELLED },
    );
    if (!cancelled) return;
    await this.whatsapp.sendText(
      transaction.user.whatsappNumber,
      "Cancelled, nothing was sent.",
      transaction.user.id,
    );
  }

  /**
   * Cancels a user's un-executed transfers (orchestrator cancel_surface).
   *
   * Covers PENDING_PIN as well as PENDING_CONFIRMATION. The PIN-awaiting state is
   * the more dangerous one to leave lying around, because it carries a live PIN
   * challenge that could still be answered later and execute a transfer the user
   * believes they abandoned.
   */
  async cancelPendingForUser(
    userId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const cancellable = [
      TransactionStatus.PENDING_CONFIRMATION,
      TransactionStatus.PENDING_PIN,
    ];
    const pending = await this.prisma.transaction.findMany({
      where: { userId, status: { in: cancellable } },
      include: { user: true },
    });
    for (const transaction of pending) {
      // Claimed, not blind-updated: between the findMany above and this write the
      // user may have tapped Confirm or answered the PIN, and cancelling a
      // transfer whose Rubies call is already in flight would leave the ledger
      // contradicting the money.
      const cancelled = await this.claimStatus(
        transaction.id,
        transaction.status as TransactionStatus,
        { status: TransactionStatus.CANCELLED },
      );
      if (!cancelled) continue;
      // A PIN-awaiting transfer is never dropped silently: the user was asked for
      // something and deserves to know the ask is withdrawn.
      if (!options?.silent || transaction.status === TransactionStatus.PENDING_PIN) {
        await this.whatsapp.sendText(
          transaction.user.whatsappNumber,
          "Cancelled, nothing was sent.",
          transaction.user.id,
        );
      }
    }
  }

  /**
   * Shared by executeVerifiedTransfer's synchronous SUCCESS/FAILED path, the
   * Rubies webhook, and the reconciliation scheduler. All three can fire for the
   * same transaction, so the transition is claimed rather than checked: without
   * it, two of them run the whole side-effect block — duplicate "Done" message,
   * duplicate OverrideHistory row (which then throws P2002), and a duplicate fee
   * sweep to Rubies.
   *
   * The claim is scoped to CONFIRMED specifically. A transaction only reaches
   * CONFIRMED immediately before the Rubies call, so any transfer Rubies has
   * money for is CONFIRMED or already terminal. That also closes the forged or
   * misrouted webhook path, where a SUCCESS event for a row still awaiting its
   * PIN would otherwise jump it straight to EXECUTED and debit the allowance for
   * money that never moved.
   */
  async applyTransferResult(
    transactionId: string,
    status: "SUCCESS" | "FAILED",
    rubiesReference?: string,
  ): Promise<void> {
    const newStatus =
      status === "SUCCESS"
        ? TransactionStatus.EXECUTED
        : TransactionStatus.FAILED;

    const { count } = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: TransactionStatus.CONFIRMED },
      data: {
        status: newStatus,
        rubiesReference,
        executedAt:
          newStatus === TransactionStatus.EXECUTED ? new Date() : undefined,
      },
    });

    if (count === 0) {
      // Two very different situations, and conflating them would hide a real bug.
      const current = await this.prisma.transaction.findUnique({
        where: { id: transactionId },
        select: { status: true },
      });
      if (
        current?.status === TransactionStatus.EXECUTED ||
        current?.status === TransactionStatus.FAILED
      ) {
        return; // benign: another handler already resolved it
      }
      this.logger.error(
        `applyTransferResult(${transactionId}) rejected: status is ${current?.status ?? "missing"}, not CONFIRMED. ` +
          `A result arrived for a transfer that was never sent.`,
      );
      return;
    }

    // Re-read after the claim: updateMany cannot include relations, and the side
    // effects below need the user and recipient rows.
    const transaction = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { user: true, recipient: true },
    });

    if (newStatus === TransactionStatus.EXECUTED) {
      if (transaction.type !== TransactionType.NORMAL) {
        try {
          await this.prisma.overrideHistory.create({
            data: {
              userId: transaction.userId,
              transactionId: transaction.id,
              type: transaction.type,
              feeAmount: transaction.feeAmount,
              waived: Number(transaction.feeAmount) === 0,
            },
          });
        } catch (err) {
          // transactionId is @unique. The status claim above should make a second
          // apply impossible, so this is belt-and-braces: an override row that
          // already exists is the correct end state, and throwing here would
          // abandon the spend recording and the user's receipt below.
          if (
            !(
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            )
          ) {
            throw err;
          }
          this.logger.warn(
            `OverrideHistory already recorded for transaction ${transaction.id}`,
          );
        }
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
      await this.tagging.touchRecipientUsed(transaction.recipientId);

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

    // Deterministic, and the exact key sent to Rubies — a randomly generated one
    // could never be found again by a status query. Distinct from the main
    // transfer's key so Rubies tracks the two independently.
    const feeReference = `${transaction.idempotencyKey ?? transaction.id}-fee`;

    // Lease the sweep before calling Rubies. Claiming on `feeSweptAt: null`
    // alone would let two concurrent appliers both send; claiming on the
    // reference being null would latch after the first try and make the row
    // permanently unrecoverable. The lease expires, so a process that dies
    // mid-call releases the row instead of stranding it.
    const now = new Date();
    const { count } = await this.prisma.transaction.updateMany({
      where: {
        id: transaction.id,
        feeSweptAt: null,
        feeSweepAttempts: { lt: FEE_SWEEP_MAX_ATTEMPTS },
        OR: [
          { feeSweepLastTryAt: null },
          { feeSweepLastTryAt: { lt: new Date(now.getTime() - FEE_SWEEP_LEASE_MS) } },
        ],
      },
      data: {
        feeSweepReference: feeReference,
        feeSweepLastTryAt: now,
        feeSweepAttempts: { increment: 1 },
      },
    });
    if (count === 0) return; // already swept, in flight elsewhere, or given up on

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
        idempotencyKey: feeReference,
      });

      if (result.status === "SUCCESS") {
        await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: { feeSweptAt: new Date() },
        });
        return;
      }

      this.logger.warn(
        `Fee sweep for transaction ${transaction.id} came back ${result.status} — will be retried`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to sweep ₦${feeAmount} fee for transaction ${transaction.id} to the fees account: ${String(err)}`,
      );
    }
  }

  /**
   * Retries fee sweeps that never resolved.
   *
   * Bounded to a day on purpose. The fee debits the customer's own wallet, so a
   * retry firing days later is a surprise debit against a balance they have
   * since spent down — a support incident on a product whose whole promise is
   * that money does not move without them seeing it. Past the window the fee is
   * written off to an ops line rather than taken.
   */
  async retryUnsweptFees(now: Date = new Date()): Promise<void> {
    const pending = await this.prisma.transaction.findMany({
      where: {
        status: TransactionStatus.EXECUTED,
        feeAmount: { gt: 0 },
        feeSweptAt: null,
        feeSweepAttempts: { lt: FEE_SWEEP_MAX_ATTEMPTS },
        executedAt: { gte: new Date(now.getTime() - FEE_SWEEP_GIVE_UP_MS) },
      },
      orderBy: { executedAt: "asc" },
      take: 100,
      include: { user: true },
    });

    for (const transaction of pending) {
      await this.sweepFeeToFeesAccount(transaction, transaction.user);
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
