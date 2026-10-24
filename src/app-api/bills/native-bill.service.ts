import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { BillPayment, PaymentSurface } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppPrincipal } from "../../app-auth/session.service";
import { BillPaymentConfirmationService } from "../../whatsapp/bill-payment-confirmation.service";
import { PinGateService } from "../../whatsapp/pin-gate.service";
import { PinOutcomeService } from "../../whatsapp/pin-outcome.service";
import { AllowanceService } from "../../allowance/allowance.service";
import { RubiesService } from "../../rubies/rubies.service";
import {
  BillPaymentCategory,
  BillPaymentStatus,
} from "../../prisma/bill-payment.enums";
import {
  findAirtimeTelco,
  MAX_AIRTIME_AMOUNT,
  MIN_AIRTIME_AMOUNT,
  normalizeMsisdn,
} from "../../whatsapp/bill-payment.constants";
import {
  findDataBundle,
  findDataTelco,
  findElectricityDisco,
  normalizeMeterNumber,
} from "../../whatsapp/bill-payment-catalog";
import { NameEnquiryService } from "../banks/name-enquiry.service";
import {
  feeNote,
  inApp,
  isUniqueViolation,
  naira,
  paymentStatus,
  surfaceOf,
} from "../payments.util";
import type { AuthorizeBillDto, CreateBillDto } from "./bills.dto";
import type {
  BillAuthorizeView,
  BillConfirmView,
  BillPaymentView,
  BillQuoteView,
} from "./bill-payment.view";

/** A purchase as the catalog defines it: what is stored and sent to Rubies. */
export interface ResolvedPurchase {
  category: BillPaymentCategory;
  billerCode: string;
  productCode: string;
  telcoLabel: string;
  productLabel?: string;
  msisdn: string;
  amount: number;
}

function refuse(error: string, extra: Record<string, unknown> = {}): never {
  throw new BadRequestException({ error, ...extra });
}

function boundedAmount(amount: number | undefined): number {
  if (amount === undefined) refuse("amount_required");
  if (amount < MIN_AIRTIME_AMOUNT || amount > MAX_AIRTIME_AMOUNT) {
    refuse("amount_out_of_range", {
      min: MIN_AIRTIME_AMOUNT,
      max: MAX_AIRTIME_AMOUNT,
    });
  }
  return amount;
}

/**
 * Turns the app's request into the purchase the WhatsApp wizards would have
 * built: every code, label, price and bound from the catalog. A product code
 * the app sends for airtime or electricity must be the catalog's own.
 */
export function resolvePurchase(dto: CreateBillDto): ResolvedPurchase {
  switch (dto.category) {
    case BillPaymentCategory.AIRTIME: {
      const telco = findAirtimeTelco(dto.billerCode);
      if (!telco) refuse("unknown_biller");
      if (
        dto.productCode !== undefined &&
        dto.productCode !== telco.productCode
      ) {
        refuse("unknown_product");
      }
      const msisdn = normalizeMsisdn(dto.target);
      if (!msisdn) refuse("bad_target");
      return {
        category: BillPaymentCategory.AIRTIME,
        billerCode: telco.billerCode,
        productCode: telco.productCode,
        telcoLabel: telco.label,
        msisdn,
        amount: boundedAmount(dto.amount),
      };
    }
    case BillPaymentCategory.DATA: {
      const telco = findDataTelco(dto.billerCode);
      if (!telco) refuse("unknown_biller");
      const bundle = dto.productCode
        ? findDataBundle(dto.billerCode, dto.productCode)
        : undefined;
      if (!bundle) refuse("unknown_product");
      if (dto.amount !== undefined) refuse("amount_not_allowed");
      const msisdn = normalizeMsisdn(dto.target);
      if (!msisdn) refuse("bad_target");
      return {
        category: BillPaymentCategory.DATA,
        billerCode: telco.billerCode,
        productCode: bundle.productCode,
        telcoLabel: telco.label,
        productLabel: bundle.label,
        msisdn,
        amount: bundle.amount,
      };
    }
    case BillPaymentCategory.ELECTRICITY: {
      const disco = findElectricityDisco(dto.billerCode);
      if (!disco) refuse("unknown_biller");
      if (
        dto.productCode !== undefined &&
        dto.productCode !== disco.productCode
      ) {
        refuse("unknown_product");
      }
      const meter = normalizeMeterNumber(dto.target);
      if (!meter) refuse("bad_target");
      return {
        category: BillPaymentCategory.ELECTRICITY,
        billerCode: disco.billerCode,
        productCode: disco.productCode,
        telcoLabel: disco.label,
        // What the WhatsApp electricity wizard stores.
        productLabel: "Prepaid electricity",
        msisdn: meter,
        amount: boundedAmount(dto.amount),
      };
    }
    default:
      return refuse("unknown_category");
  }
}

/**
 * The app's bill screens: quote, confirm, PIN, result, for airtime, data and
 * prepaid electricity. The same decisions as the conversation
 * (BillPaymentConfirmationService.createQuote and evaluateConfirm,
 * PinGateService, PinOutcomeService), answered as data. See
 * NativeTransferService for the channel context and why there is no turn
 * lease; both apply here unchanged.
 */
@Injectable()
export class NativeBillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bills: BillPaymentConfirmationService,
    private readonly pinGate: PinGateService,
    private readonly pinOutcome: PinOutcomeService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly lookups: NameEnquiryService,
  ) {}

  /**
   * A quote under the app's Idempotency-Key. A key seen before returns that
   * purchase, as it is now; the same key for a different purchase is refused.
   */
  quote(
    principal: AppPrincipal,
    key: string,
    dto: CreateBillDto,
  ): Promise<{ replayed: boolean; view: BillQuoteView }> {
    const purchase = resolvePurchase(dto);
    return inApp(principal, async () => {
      const existing = await this.findByKey(principal.userId, key);
      if (existing) {
        return { replayed: true, view: await this.replay(existing, purchase) };
      }

      const account = await this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { rubiesAccountNumber: true },
      });
      if (!account.rubiesAccountNumber) {
        throw new ConflictException({ error: "no_account" });
      }

      // The meter check returns the name the electricity company holds for
      // it, so it spends from the same hourly budget as account-name lookups.
      // The name stored and shown is Rubies' answer; the app cannot supply it.
      let customerName: string | undefined;
      if (purchase.category === BillPaymentCategory.ELECTRICITY) {
        await this.lookups.claimLookup(principal.userId);
        const meter = await this.rubies.validateVasCustomer({
          billerCode: purchase.billerCode,
          productCode: purchase.productCode,
          billerCustomerId: purchase.msisdn,
        });
        if (!meter.ok || !meter.customerName) {
          throw new UnprocessableEntityException({ error: "meter_unverified" });
        }
        customerName = meter.customerName;
      }

      let result;
      try {
        result = await this.bills.createQuote({
          userId: principal.userId,
          ...purchase,
          customerName,
          surface: PaymentSurface.NATIVE,
          clientRequestKey: key,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const winner = await this.findByKey(principal.userId, key);
          if (winner) {
            return {
              replayed: true,
              view: await this.replay(winner, purchase),
            };
          }
        }
        throw err;
      }
      if (!result.ok) throw new ConflictException({ error: "no_account" });

      const fee = result.evaluation.feeAmount;
      return {
        replayed: false,
        view: {
          payment: this.view(result.payment),
          balanceAfter:
            result.balance === null
              ? null
              : naira(result.balance - purchase.amount - fee),
          allowanceLeftToday: naira(
            result.evaluation.remainingToday - purchase.amount,
          ),
        },
      };
    });
  }

  confirm(principal: AppPrincipal, id: string): Promise<BillConfirmView> {
    return inApp(principal, async () => {
      const decision = await this.bills.evaluateConfirm(
        principal.userId,
        id,
        PaymentSurface.NATIVE,
      );
      switch (decision.kind) {
        case "not_found":
          throw new NotFoundException({ error: "not_found" });
        case "not_pending": {
          // Asked again while the PIN is awaited: the app lost the token, so
          // issue another. Only one execution can win the claim after it.
          if (decision.payment.status === BillPaymentStatus.PENDING_PIN) {
            return {
              decision: "pin_required",
              payment: await this.load(principal.userId, id),
              pinToken: await this.pinGate.issueBillPaymentPinToken(
                decision.payment.user,
                id,
              ),
            };
          }
          throw new ConflictException({
            error: "not_awaiting_confirmation",
            status: paymentStatus(
              (await this.row(principal.userId, id))!.status,
            ),
          });
        }
        case "balance_unavailable":
          throw new ServiceUnavailableException({
            error: "balance_unavailable",
          });
        case "insufficient_funds":
          return {
            decision: "insufficient_funds",
            payment: await this.load(principal.userId, id),
            needed: decision.needed,
            balance: decision.balance,
          };
        case "requoted": {
          const amount = Number(decision.payment.amount);
          return {
            decision: "requoted",
            payment: await this.load(principal.userId, id),
            requote: {
              reason: decision.reason,
              balanceAfter: naira(
                decision.balance - amount - decision.evaluation.feeAmount,
              ),
              allowanceLeftToday: naira(
                decision.evaluation.remainingToday - amount,
              ),
            },
          };
        }
        case "pin_setup_required":
          return {
            decision: "pin_setup_required",
            payment: await this.load(principal.userId, id),
            setupToken: await this.pinGate.issuePinSetupToken(
              decision.payment.user,
            ),
          };
        case "locked":
          return {
            decision: "locked",
            payment: await this.load(principal.userId, id),
            lockedUntil:
              decision.payment.user.pinLockedUntil?.toISOString() ?? null,
          };
        case "pin_required":
          return {
            decision: "pin_required",
            payment: await this.load(principal.userId, id),
            pinToken: await this.pinGate.issueBillPaymentPinToken(
              decision.payment.user,
              id,
            ),
          };
      }
    });
  }

  /**
   * The PIN. Checked only while the purchase is waiting for one, so a PIN sent
   * for a cancelled or finished purchase is not spent as an attempt.
   */
  authorize(
    principal: AppPrincipal,
    id: string,
    dto: AuthorizeBillDto,
  ): Promise<BillAuthorizeView> {
    return inApp(principal, async () => {
      const row = await this.row(principal.userId, id, PaymentSurface.NATIVE);
      if (!row) throw new NotFoundException({ error: "not_found" });
      if (row.status !== BillPaymentStatus.PENDING_PIN) {
        throw new ConflictException({
          error: "not_awaiting_pin",
          status: paymentStatus(row.status),
        });
      }

      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
      });
      const check = await this.pinGate.authorizeBillPayment(
        user,
        dto.pinToken,
        id,
        dto.pin,
      );
      switch (check.kind) {
        case "expired":
          return { result: "expired", payment: this.view(row) };
        case "wrong_pin":
          return {
            result: "wrong_pin",
            payment: this.view(row),
            message: check.message,
            retryToken: check.retryToken,
          };
        case "locked":
          return {
            result: "locked",
            payment: await this.load(principal.userId, id),
            message: check.message,
          };
        case "verified": {
          const applied = await this.pinOutcome.apply(
            check.outcome,
            principal.userId,
            { quiet: true },
          );
          const payment = await this.load(principal.userId, id);
          if (applied.kind === "capped") {
            return {
              result: "cap_exceeded",
              payment,
              cap: {
                cap: applied.cap,
                remaining: applied.remaining,
                liftsAt: applied.liftsAt.toISOString(),
              },
            };
          }
          const result =
            payment.status === "successful" ||
            payment.status === "failed" ||
            payment.status === "processing"
              ? payment.status
              : // Cancelled between the PIN check and the claim to buy.
                "expired";
          return { result, payment };
        }
      }
    });
  }

  async get(principal: AppPrincipal, id: string): Promise<BillPaymentView> {
    return this.load(principal.userId, id);
  }

  async cancel(principal: AppPrincipal, id: string): Promise<BillPaymentView> {
    const cancelled = await this.bills.withdraw(principal.userId, id);
    const row = await this.row(principal.userId, id, PaymentSurface.NATIVE);
    if (!row) throw new NotFoundException({ error: "not_found" });
    if (!cancelled) {
      throw new ConflictException({
        error: "not_cancellable",
        status: paymentStatus(row.status),
      });
    }
    return this.view(row);
  }

  private findByKey(
    userId: string,
    clientRequestKey: string,
  ): Promise<BillPayment | null> {
    return this.prisma.billPayment.findUnique({
      where: { userId_clientRequestKey: { userId, clientRequestKey } },
    });
  }

  private async replay(
    row: BillPayment,
    purchase: ResolvedPurchase,
  ): Promise<BillQuoteView> {
    if (
      row.category !== purchase.category ||
      row.billerCode !== purchase.billerCode ||
      row.productCode !== purchase.productCode ||
      row.msisdn !== purchase.msisdn ||
      Number(row.amount) !== purchase.amount
    ) {
      throw new UnprocessableEntityException({
        error: "idempotency_key_reused",
      });
    }
    const payment = this.view(row);
    if (row.status !== BillPaymentStatus.PENDING_CONFIRMATION) {
      return { payment, balanceAfter: null, allowanceLeftToday: null };
    }
    // Fresh figures for a quote still on screen; the terms themselves are
    // re-checked at confirm.
    const amount = Number(row.amount);
    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: row.userId },
      select: { rubiesAccountNumber: true },
    });
    const [balance, summary] = await Promise.all([
      account.rubiesAccountNumber
        ? this.rubies.getBalance(account.rubiesAccountNumber).catch(() => null)
        : Promise.resolve(null),
      this.allowance.getRemainingSummary(row.userId),
    ]);
    return {
      payment,
      balanceAfter:
        balance === null
          ? null
          : naira(balance - amount - Number(row.feeAmount)),
      allowanceLeftToday: naira(summary.remainingToday - amount),
    };
  }

  /** The caller's own purchase, from either surface; null otherwise. */
  private row(
    userId: string,
    id: string,
    surface?: PaymentSurface,
  ): Promise<BillPayment | null> {
    return this.prisma.billPayment.findFirst({
      where: { id, userId, ...(surface ? { originSurface: surface } : {}) },
    });
  }

  private async load(userId: string, id: string): Promise<BillPaymentView> {
    const row = await this.row(userId, id);
    if (!row) throw new NotFoundException({ error: "not_found" });
    return this.view(row);
  }

  private view(row: BillPayment): BillPaymentView {
    const fee = Number(row.feeAmount);
    return {
      id: row.id,
      status: paymentStatus(row.status),
      category: row.category,
      provider: row.telcoLabel,
      product: row.productLabel,
      target: row.msisdn,
      customerName: row.customerName,
      amount: Number(row.amount),
      fee,
      spendType: row.type,
      feeNote: feeNote(row.type, fee),
      token: row.status === BillPaymentStatus.EXECUTED ? row.vendorToken : null,
      surface: surfaceOf(row.originSurface),
      createdAt: row.createdAt.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      executedAt: row.executedAt?.toISOString() ?? null,
    };
  }
}
