import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { RubiesService } from "../rubies/rubies.service";
import { WhatsappService } from "./whatsapp.service";
import { PinGateService } from "./pin-gate.service";
import { TransactionType } from "@prisma/client";
import {
  BillPaymentCategory,
  BillPaymentStatus,
} from "../prisma/bill-payment.enums";
import {
  CANCEL_BILL_PREFIX,
  CONFIRM_BILL_PREFIX,
} from "./bill-payment.constants";
import { formatSpendFeeLine } from "./transfer-confirmation.service";
import { TransactionType as LocalTransactionType } from "../common/enums/transaction-type.enum";

@Injectable()
export class BillPaymentConfirmationService {
  private readonly logger = new Logger(BillPaymentConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly whatsapp: WhatsappService,
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
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "you don't have a udara account set up yet.",
        user.id,
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

    const bodyLines = [buildConfirmLine(params)];
    const feeLine = formatSpendFeeLine(
      evaluation.type as LocalTransactionType,
      evaluation.feeAmount,
      evaluation.waived,
    );
    if (feeLine) bodyLines.push(feeLine);

    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch(() => null);
    if (balance !== null) {
      const total = params.amount + evaluation.feeAmount;
      bodyLines.push(
        `Account balance after this: ₦${Math.max(0, balance - total).toLocaleString("en-NG")}`,
      );
    }
    bodyLines.push(
      `Allowance left today after this: ₦${Math.max(0, evaluation.remainingToday - params.amount).toLocaleString("en-NG")}`,
    );

    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      bodyLines.join("\n"),
      [
        { id: `${CONFIRM_BILL_PREFIX}${payment.id}`, title: "Confirm" },
        { id: `${CANCEL_BILL_PREFIX}${payment.id}`, title: "Cancel" },
      ],
      user.id,
    );
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

  async confirmBillPayment(billPaymentId: string): Promise<void> {
    const payment = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
      include: { user: true },
    });
    if (!payment || payment.status !== BillPaymentStatus.PENDING_CONFIRMATION) {
      return;
    }

    const { user } = payment;
    if (!user.rubiesAccountNumber) {
      throw new BadRequestException(`User ${user.id} has no Rubies account`);
    }

    const balance = await this.rubies.getBalance(user.rubiesAccountNumber);
    const totalCost = Number(payment.amount) + Number(payment.feeAmount);
    if (balance < totalCost) {
      await this.prisma.billPayment.update({
        where: { id: payment.id },
        data: { status: BillPaymentStatus.FAILED },
      });
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `That needs ₦${totalCost.toLocaleString("en-NG")} but your account only has ₦${balance.toLocaleString("en-NG")}. Cancelled.`,
        user.id,
      );
      return;
    }

    if (!user.pinHash) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "before your first purchase, you need to set a 4-digit pin.",
        user.id,
      );
      await this.pinGate.requestPinSetup(user);
      return;
    }

    if (this.pinGate.isLocked(user)) {
      await this.prisma.billPayment.update({
        where: { id: payment.id },
        data: { status: BillPaymentStatus.CANCELLED },
      });
      await this.pinGate.notifyLocked(user);
      return;
    }

    await this.prisma.billPayment.update({
      where: { id: payment.id },
      data: { status: BillPaymentStatus.PENDING_PIN },
    });
    await this.pinGate.requestBillPaymentPin(user, payment.id);
  }

  async cancelBillPayment(billPaymentId: string): Promise<void> {
    const payment = await this.prisma.billPayment.findUnique({
      where: { id: billPaymentId },
      include: { user: true },
    });
    if (
      !payment ||
      payment.status !== BillPaymentStatus.PENDING_CONFIRMATION
    ) {
      return;
    }

    await this.prisma.billPayment.update({
      where: { id: billPaymentId },
      data: { status: BillPaymentStatus.CANCELLED },
    });
    await this.whatsapp.sendText(
      payment.user.whatsappNumber,
      cancelMessageForCategory(payment.category),
      payment.user.id,
    );
  }

  async cancelPendingForUser(
    userId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const pending = await this.prisma.billPayment.findMany({
      where: {
        userId,
        status: BillPaymentStatus.PENDING_CONFIRMATION,
      },
      include: { user: true },
    });
    for (const payment of pending) {
      await this.prisma.billPayment.update({
        where: { id: payment.id },
        data: { status: BillPaymentStatus.CANCELLED },
      });
      if (!options?.silent) {
        await this.whatsapp.sendText(
          payment.user.whatsappNumber,
          cancelMessageForCategory(payment.category),
          payment.user.id,
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

    await this.prisma.billPayment.update({
      where: { id: payment.id },
      data: { status: BillPaymentStatus.CONFIRMED, confirmedAt: new Date() },
    });

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
      await this.whatsapp.sendText(
        user.whatsappNumber,
        processingMessageForCategory(payment.category),
        user.id,
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
    const payment = await this.prisma.billPayment.findUniqueOrThrow({
      where: { id: billPaymentId },
      include: { user: true },
    });

    if (
      payment.status === BillPaymentStatus.EXECUTED ||
      payment.status === BillPaymentStatus.FAILED
    ) {
      return;
    }

    const newStatus =
      status === "SUCCESS"
        ? BillPaymentStatus.EXECUTED
        : BillPaymentStatus.FAILED;

    await this.prisma.billPayment.update({
      where: { id: billPaymentId },
      data: {
        status: newStatus,
        rubiesReference,
        vendorToken: vendorToken ?? payment.vendorToken ?? undefined,
        executedAt: newStatus === BillPaymentStatus.EXECUTED ? new Date() : undefined,
      },
    });

    if (newStatus === BillPaymentStatus.EXECUTED) {
      await this.allowance.recordBillPaymentSpend(payment.id);
      await this.whatsapp.sendText(
        payment.user.whatsappNumber,
        successMessageForPayment(payment, vendorToken ?? payment.vendorToken),
        payment.user.id,
      );
    } else {
      await this.whatsapp.sendText(
        payment.user.whatsappNumber,
        failureMessageForCategory(payment.category),
        payment.user.id,
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
        await this.pinGate.requestBillPaymentPin(pendingBill.user, pendingBill.id);
      } else {
        await this.confirmBillPayment(pendingBill.id);
      }
    }
  }
}

function buildConfirmLine(params: {
  category: BillPaymentCategory;
  amount: number;
  telcoLabel: string;
  msisdn: string;
  productLabel?: string;
  customerName?: string;
}): string {
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
