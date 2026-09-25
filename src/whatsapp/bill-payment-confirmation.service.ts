import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { RubiesService } from "../rubies/rubies.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { PinGateService } from "./pin-gate.service";
import { BillPayment, TransactionType, User } from "@prisma/client";
import {
  BillPaymentCategory,
  BillPaymentStatus,
} from "../prisma/bill-payment.enums";
import {
  CANCEL_BILL_PREFIX,
  CONFIRM_BILL_PREFIX,
} from "./bill-payment.constants";
import {
  CONFIRM_RE_QUOTE_AFTER_MS,
  formatSpendFeeLine,
} from "./transfer-confirmation.service";
import { TransactionType as LocalTransactionType } from "../common/enums/transaction-type.enum";

@Injectable()
export class BillPaymentConfirmationService {
  private readonly logger = new Logger(BillPaymentConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly messenger: ChannelMessenger,
    private readonly pinGate: PinGateService,
  ) {}

  async initiateBillPayment(params: {
    userId: string;
    category: BillPaymentCategory;
    billerCode: string;
    productCode: string;
    telcoLabel: string;
    msisdn: string;
    amount: number;
    productLabel?: string;
    customerName?: string;
  }): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.userId },
    });

    if (!user.rubiesAccountNumber) {
      await this.messenger.sendText(
        user,
        "you don't have a udara account set up yet.",
      );
      return;
    }

    const evaluation = await this.allowance.evaluateSpend(
      params.userId,
      params.amount,
    );

    const requestReference = `UDARA-BILL-${randomUUID()}`;
    const payment = await this.prisma.billPayment.create({
      data: {
        userId: params.userId,
        category: params.category,
        billerCode: params.billerCode,
        productCode: params.productCode,
        telcoLabel: params.telcoLabel,
        productLabel: params.productLabel,
        customerName: params.customerName,
        msisdn: params.msisdn,
        amount: params.amount,
        type: evaluation.type as unknown as TransactionType,
        status: BillPaymentStatus.PENDING_CONFIRMATION,
        feeAmount: evaluation.feeAmount,
        requestReference,
        idempotencyKey: requestReference,
      },
    });

    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch(() => null);
    await this.sendQuoteCard(user, payment.id, params, evaluation, balance);
  }

  /**
   * The Confirm/Cancel card. Shared by the first quote and the re-quote in
   * confirmBillPayment, so a re-quoted purchase shows exactly the figures a
   * fresh one would, under a one-line explanation of why it came back.
   */
  private async sendQuoteCard(
    user: User,
    billPaymentId: string,
    purchase: QuotedPurchase,
    evaluation: QuoteEvaluation,
    balance: number | null,
    heading?: string,
  ): Promise<void> {
    const bodyLines = heading
      ? [heading, buildConfirmLine(purchase)]
      : [buildConfirmLine(purchase)];
    const feeLine = formatSpendFeeLine(
      evaluation.type,
      evaluation.feeAmount,
      evaluation.waived,
    );
    if (feeLine) bodyLines.push(feeLine);

    if (balance !== null) {
      const total = purchase.amount + evaluation.feeAmount;
      bodyLines.push(
        `Account balance after this: ₦${Math.max(0, balance - total).toLocaleString("en-NG")}`,
      );
    }
    bodyLines.push(
      `Allowance left today after this: ₦${Math.max(0, evaluation.remainingToday - purchase.amount).toLocaleString("en-NG")}`,
    );

    await this.messenger.sendButtons(user, bodyLines.join("\n"), [
      { id: `${CONFIRM_BILL_PREFIX}${billPaymentId}`, title: "Confirm" },
      { id: `${CANCEL_BILL_PREFIX}${billPaymentId}`, title: "Cancel" },
    ]);
  }

  /** @deprecated use initiateBillPayment */
  async initiateAirtimePurchase(params: {
    userId: string;
    billerCode: string;
    productCode: string;
    telcoLabel: string;
    msisdn: string;
    amount: number;
  }): Promise<void> {
    return this.initiateBillPayment({
      ...params,
      category: BillPaymentCategory.AIRTIME,
    });
  }

  /**
   * Scoped to `userId`: the id comes from a button payload, which stops being
   * unforgeable once a client other than WhatsApp can name it. See
   * TransferConfirmationService.confirmTransfer.
   */
  async confirmBillPayment(
    userId: string,
    billPaymentId: string,
  ): Promise<void> {
    const payment = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId, userId },
      include: { user: true },
    });
    if (!payment || payment.status !== BillPaymentStatus.PENDING_CONFIRMATION) {
      return;
    }

    const { user } = payment;
    if (!user.rubiesAccountNumber) {
      throw new BadRequestException(`User ${user.id} has no Rubies account`);
    }

    // Same reasoning as TransferConfirmationService.confirmTransfer: a Rubies
    // blip here used to throw out to the controller and the user got nothing.
    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch((err) => {
        this.logger.warn(
          `confirmBillPayment: balance check failed for ${payment.id}: ${String(err)}`,
        );
        return null;
      });
    if (balance === null) {
      await this.messenger.sendText(
        user,
        "i couldn't check your balance just now. tap confirm again in a moment.",
      );
      return;
    }
    const totalCost = Number(payment.amount) + Number(payment.feeAmount);
    if (balance < totalCost) {
      const failed = await this.claimStatus(
        payment.id,
        BillPaymentStatus.PENDING_CONFIRMATION,
        { status: BillPaymentStatus.FAILED },
      );
      if (!failed) return;
      await this.messenger.sendText(
        user,
        `That needs ₦${totalCost.toLocaleString("en-NG")} but your account only has ₦${balance.toLocaleString("en-NG")}. Cancelled.`,
      );
      return;
    }

    // Same rule as transfers: fee and spend type were frozen at quote time, so
    // a purchase left sitting could otherwise execute at zero-fee terms after
    // the window closed. Re-quote rather than fail; the row stays
    // PENDING_CONFIRMATION and the user authorises the figures in front of them.
    const stale =
      Date.now() - payment.createdAt.getTime() > CONFIRM_RE_QUOTE_AFTER_MS;
    const fresh = await this.allowance.evaluateSpend(
      payment.userId,
      Number(payment.amount),
    );
    const termsChanged =
      fresh.type !== (payment.type as unknown as LocalTransactionType) ||
      fresh.feeAmount !== Number(payment.feeAmount);
    if (stale || termsChanged) {
      await this.prisma.billPayment.updateMany({
        where: {
          id: payment.id,
          status: BillPaymentStatus.PENDING_CONFIRMATION,
        },
        data: {
          type: fresh.type as unknown as TransactionType,
          feeAmount: fresh.feeAmount,
        },
      });
      await this.sendQuoteCard(
        user,
        payment.id,
        purchaseFromRow(payment),
        fresh,
        balance,
        termsChanged
          ? "the terms on this one moved while it was waiting, so here it is again:"
          : "this has been waiting a while, so let's confirm it again:",
      );
      return;
    }

    if (!user.pinHash) {
      await this.messenger.sendText(
        user,
        "before your first purchase, you need to set a 4-digit pin.",
      );
      await this.pinGate.requestPinSetup(user);
      return;
    }

    if (this.pinGate.isLocked(user)) {
      const cancelled = await this.claimStatus(
        payment.id,
        BillPaymentStatus.PENDING_CONFIRMATION,
        { status: BillPaymentStatus.CANCELLED },
      );
      if (!cancelled) return;
      await this.pinGate.notifyLocked(user);
      return;
    }

    // Claimed, not blind-updated — see TransferConfirmationService.claimStatus
    // for why the status read at the top of this method cannot be the guard.
    const claimed = await this.claimStatus(
      payment.id,
      BillPaymentStatus.PENDING_CONFIRMATION,
      { status: BillPaymentStatus.PENDING_PIN },
    );
    if (!claimed) return;
    await this.pinGate.requestBillPaymentPin(user, payment.id);
  }

  /**
   * Moves a bill payment from one status to another, atomically, reporting
   * whether this caller won. Mirrors TransferConfirmationService.claimStatus;
   * the two exist separately because Prisma types the two models' update inputs
   * independently.
   */
  private async claimStatus(
    billPaymentId: string,
    from: BillPaymentStatus,
    // Not Prisma.BillPaymentUpdateManyMutationInput: the bill-pay models are
    // reached through a local enum shim (see prisma/bill-payment.enums.ts), so
    // the generated namespace does not carry them here.
    data: { status: BillPaymentStatus; confirmedAt?: Date },
  ): Promise<boolean> {
    const { count } = await this.prisma.billPayment.updateMany({
      where: { id: billPaymentId, status: from },
      data,
    });
    if (count === 0) {
      this.logger.warn(
        `bill payment ${billPaymentId} was not in ${from} — another handler claimed it first`,
      );
      return false;
    }
    return true;
  }

  /** Scoped to `userId` for the same reason as confirmBillPayment. */
  async cancelBillPayment(
    userId: string,
    billPaymentId: string,
  ): Promise<void> {
    const payment = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId, userId },
      include: { user: true },
    });
    if (!payment || payment.status !== BillPaymentStatus.PENDING_CONFIRMATION) {
      return;
    }

    // Claimed, not blind-updated: a Confirm tap racing this Cancel could move
    // the row to PENDING_PIN, and an unconditional write would then cancel it
    // underneath a live PIN challenge.
    const cancelled = await this.claimStatus(
      payment.id,
      BillPaymentStatus.PENDING_CONFIRMATION,
      { status: BillPaymentStatus.CANCELLED },
    );
    if (!cancelled) return;
    await this.messenger.sendText(
      payment.user,
      cancelMessageForCategory(payment.category),
    );
  }

  /**
   * Covers PENDING_PIN as well as PENDING_CONFIRMATION, matching
   * TransferConfirmationService.cancelPendingForUser. A PIN-awaiting purchase
   * carries a live challenge that could still be answered later and buy
   * something the user believes they abandoned.
   */
  async cancelPendingForUser(
    userId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const pending = await this.prisma.billPayment.findMany({
      where: {
        userId,
        status: {
          in: [
            BillPaymentStatus.PENDING_CONFIRMATION,
            BillPaymentStatus.PENDING_PIN,
          ],
        },
      },
      include: { user: true },
    });
    for (const payment of pending) {
      const cancelled = await this.claimStatus(
        payment.id,
        payment.status as BillPaymentStatus,
        { status: BillPaymentStatus.CANCELLED },
      );
      if (!cancelled) continue;
      // A PIN-awaiting purchase is never dropped silently: the user was asked
      // for something and deserves to know the ask is withdrawn.
      if (
        !options?.silent ||
        payment.status === BillPaymentStatus.PENDING_PIN
      ) {
        await this.messenger.sendText(
          payment.user,
          cancelMessageForCategory(payment.category),
        );
      }
    }
  }

  async executeVerifiedBillPayment(billPaymentId: string): Promise<void> {
    const payment = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
      include: { user: true },
    });
    if (!payment) {
      this.logger.warn(
        `executeVerifiedBillPayment: no such payment ${billPaymentId}`,
      );
      return;
    }
    if (payment.status !== BillPaymentStatus.PENDING_PIN) {
      this.logger.warn(
        `executeVerifiedBillPayment: payment ${billPaymentId} is ${payment.status}, not PENDING_PIN`,
      );
      return;
    }

    const { user } = payment;
    if (!user.rubiesAccountNumber || !user.rubiesAccountName) {
      throw new BadRequestException(
        `User ${user.id} has no Rubies account to debit`,
      );
    }

    // Claimed from PENDING_PIN before the VAS call, for the same reason as
    // transfers: several valid PIN challenges can exist for one payment, so two
    // concurrent executions would otherwise both reach Rubies.
    const claimed = await this.claimStatus(
      payment.id,
      BillPaymentStatus.PENDING_PIN,
      { status: BillPaymentStatus.CONFIRMED, confirmedAt: new Date() },
    );
    if (!claimed) return;

    const requestReference =
      payment.requestReference ?? payment.idempotencyKey ?? payment.id;

    const purchaseCustomerName =
      payment.category === BillPaymentCategory.ELECTRICITY
        ? (payment.customerName ?? user.rubiesAccountName)
        : user.rubiesAccountName;

    const result = await this.rubies.purchaseVas({
      accountNumber: user.rubiesAccountNumber,
      billerCustomerId: payment.msisdn,
      productCode: payment.productCode,
      amount: Number(payment.amount),
      requestReference,
      customerName: purchaseCustomerName,
    });

    if (result.status === "PENDING") {
      await this.messenger.sendText(
        user,
        processingMessageForCategory(payment.category),
      );
      return;
    }

    await this.applyBillPaymentResult(
      payment.id,
      result.status,
      result.reference,
      result.vendorToken,
    );
  }

  async applyBillPaymentResult(
    billPaymentId: string,
    status: "SUCCESS" | "FAILED",
    rubiesReference?: string,
    vendorToken?: string,
  ): Promise<void> {
    const existing = await this.prisma.billPayment.findUniqueOrThrow({
      where: { id: billPaymentId },
      include: { user: true },
    });

    const newStatus =
      status === "SUCCESS"
        ? BillPaymentStatus.EXECUTED
        : BillPaymentStatus.FAILED;

    // Claimed from CONFIRMED only, so a result arriving for a payment that was
    // never sent cannot debit the allowance and send a receipt. Mirrors
    // TransferConfirmationService.applyTransferResult.
    const { count } = await this.prisma.billPayment.updateMany({
      where: { id: billPaymentId, status: BillPaymentStatus.CONFIRMED },
      data: {
        status: newStatus,
        rubiesReference,
        vendorToken: vendorToken ?? existing.vendorToken ?? undefined,
        executedAt:
          newStatus === BillPaymentStatus.EXECUTED ? new Date() : undefined,
      },
    });

    if (count === 0) {
      if (
        existing.status === BillPaymentStatus.EXECUTED ||
        existing.status === BillPaymentStatus.FAILED
      ) {
        return; // benign: already resolved by another handler
      }
      this.logger.error(
        `applyBillPaymentResult(${billPaymentId}) rejected: status is ${existing.status}, not CONFIRMED. ` +
          `A result arrived for a purchase that was never sent.`,
      );
      return;
    }

    const payment = existing;

    if (newStatus === BillPaymentStatus.EXECUTED) {
      await this.allowance.recordBillPaymentSpend(payment.id);
      await this.messenger.sendText(
        payment.user,
        successMessageForPayment(payment, vendorToken ?? payment.vendorToken),
        { delivery: "transactional" },
      );
    } else {
      await this.messenger.sendText(
        payment.user,
        failureMessageForCategory(payment.category),
        { delivery: "transactional" },
      );
    }
  }

  async resumeAfterPinSetup(userId: string): Promise<void> {
    const pendingBill = await this.prisma.billPayment.findFirst({
      where: {
        userId,
        status: {
          in: [
            BillPaymentStatus.PENDING_CONFIRMATION,
            BillPaymentStatus.PENDING_PIN,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });
    if (pendingBill) {
      if (pendingBill.status === BillPaymentStatus.PENDING_PIN) {
        await this.pinGate.requestBillPaymentPin(
          pendingBill.user,
          pendingBill.id,
        );
      } else {
        await this.confirmBillPayment(userId, pendingBill.id);
      }
    }
  }
}

/** What the quote card describes: the thing being bought, not the row. */
type QuotedPurchase = {
  category: BillPaymentCategory;
  amount: number;
  telcoLabel: string;
  msisdn: string;
  productLabel?: string;
  customerName?: string;
};

type QuoteEvaluation = {
  type: LocalTransactionType;
  feeAmount: number;
  waived: boolean;
  remainingToday: number;
};

/** The quote-card inputs, read back off a stored row for a re-quote. */
function purchaseFromRow(
  payment: Pick<
    BillPayment,
    | "category"
    | "amount"
    | "telcoLabel"
    | "msisdn"
    | "productLabel"
    | "customerName"
  >,
): QuotedPurchase {
  return {
    category: payment.category as unknown as BillPaymentCategory,
    amount: Number(payment.amount),
    telcoLabel: payment.telcoLabel,
    msisdn: payment.msisdn,
    productLabel: payment.productLabel ?? undefined,
    customerName: payment.customerName ?? undefined,
  };
}

function buildConfirmLine(params: QuotedPurchase): string {
  const amount = `₦${params.amount.toLocaleString("en-NG")}`;
  switch (params.category) {
    case BillPaymentCategory.DATA:
      return `Buy ${params.productLabel ?? "data"} (${amount}) for ${params.msisdn} on ${params.telcoLabel}?`;
    case BillPaymentCategory.ELECTRICITY:
      return `Buy ${amount} prepaid electricity for ${params.customerName ?? "this meter"} (${params.msisdn}) on ${params.telcoLabel}?`;
    default:
      return `Buy ${amount} ${params.telcoLabel} airtime for ${params.msisdn}?`;
  }
}

function successMessageForPayment(
  payment: {
    category: BillPaymentCategory;
    amount: unknown;
    telcoLabel: string;
    msisdn: string;
    productLabel: string | null;
  },
  vendorToken?: string | null,
): string {
  const amount = `₦${Number(payment.amount).toLocaleString("en-NG")}`;
  switch (payment.category) {
    case BillPaymentCategory.DATA:
      return `Done, ${payment.productLabel ?? "data"} (${amount}) sent to ${payment.msisdn} on ${payment.telcoLabel}.`;
    case BillPaymentCategory.ELECTRICITY: {
      const base = `Done, ${amount} prepaid electricity for meter ${payment.msisdn} on ${payment.telcoLabel}.`;
      return vendorToken ? `${base}\n\nToken: ${vendorToken}` : base;
    }
    default:
      return `Done, ${amount} ${payment.telcoLabel} airtime sent to ${payment.msisdn}.`;
  }
}

function cancelMessageForCategory(category: BillPaymentCategory): string {
  switch (category) {
    case BillPaymentCategory.DATA:
      return "Cancelled, no data was bought.";
    case BillPaymentCategory.ELECTRICITY:
      return "Cancelled, no electricity was bought.";
    default:
      return "Cancelled, no airtime was bought.";
  }
}

function failureMessageForCategory(category: BillPaymentCategory): string {
  switch (category) {
    case BillPaymentCategory.DATA:
      return "that data purchase failed, nothing was deducted from today's allowance.";
    case BillPaymentCategory.ELECTRICITY:
      return "that electricity purchase failed, nothing was deducted from today's allowance.";
    default:
      return "that airtime purchase failed, nothing was deducted from today's allowance.";
  }
}

function processingMessageForCategory(category: BillPaymentCategory): string {
  switch (category) {
    case BillPaymentCategory.DATA:
      return "your data purchase is processing, i'll confirm once it's done.";
    case BillPaymentCategory.ELECTRICITY:
      return "your electricity purchase is processing, i'll confirm once it's done.";
    default:
      return "your airtime purchase is processing, i'll confirm once it's done.";
  }
}
