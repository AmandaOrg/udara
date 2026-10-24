import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  PaymentSurface,
  Recipient,
  Transaction,
  TransactionStatus,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppPrincipal } from "../../app-auth/session.service";
import { TransferConfirmationService } from "../../whatsapp/transfer-confirmation.service";
import { PinGateService } from "../../whatsapp/pin-gate.service";
import { PinOutcomeService } from "../../whatsapp/pin-outcome.service";
import { AllowanceService } from "../../allowance/allowance.service";
import { RubiesService } from "../../rubies/rubies.service";
import { TaggingService } from "../../tagging/tagging.service";
import { BankDirectoryService } from "../banks/bank-directory.service";
import { NameEnquiryService } from "../banks/name-enquiry.service";
import type { AuthorizeTransferDto, CreateTransferDto } from "./transfers.dto";
import type {
  AuthorizeView,
  ConfirmView,
  QuoteView,
  TransferView,
} from "./transfer.view";
import {
  feeNote,
  inApp,
  isUniqueViolation,
  naira,
  paymentStatus,
  surfaceOf,
} from "../payments.util";

type TransferRow = Transaction & { recipient: Recipient };

/**
 * The app's send-money screens: quote, confirm, PIN, result. The same
 * decisions as the conversation (TransferConfirmationService.createQuote and
 * evaluateConfirm, PinGateService, PinOutcomeService), answered as data.
 *
 * Every call runs in the app's channel context, so the quote's originChannel
 * is APP, the new-device cap applies to the PIN, and a result known during
 * the request lands in the app chat without a push. Nothing here writes a
 * quote card or a PIN form into the chat: those belong to the screen.
 *
 * No turn lease: these routes touch no conversation state, and every money
 * transition they cause is already an atomic claim.
 */
@Injectable()
export class NativeTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: TransferConfirmationService,
    private readonly pinGate: PinGateService,
    private readonly pinOutcome: PinOutcomeService,
    private readonly allowance: AllowanceService,
    private readonly rubies: RubiesService,
    private readonly banks: BankDirectoryService,
    private readonly tagging: TaggingService,
    private readonly lookups: NameEnquiryService,
  ) {}

  /**
   * A quote under the app's Idempotency-Key. A key seen before returns that
   * transfer, as it is now; the same key for a different send is refused.
   */
  quote(
    principal: AppPrincipal,
    key: string,
    dto: CreateTransferDto,
  ): Promise<{ replayed: boolean; view: QuoteView }> {
    return inApp(principal, async () => {
      const existing = await this.findByKey(principal.userId, key);
      if (existing) {
        return { replayed: true, view: await this.replay(existing, dto) };
      }

      // A quote to someone not yet saved asks the bank for their name and
      // shows it, which is what POST /v1/name-enquiry does. It spends from
      // the same hourly budget, or this route would be a way around it.
      const account = await this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { rubiesAccountNumber: true },
      });
      if (!account.rubiesAccountNumber) {
        throw new ConflictException({ error: "no_account" });
      }
      const saved = await this.tagging.findRecipient(
        principal.userId,
        dto.accountNumber,
        dto.bankCode,
      );
      if (!saved) await this.lookups.claimLookup(principal.userId);

      let result;
      try {
        result = await this.transfers.createQuote({
          userId: principal.userId,
          accountNumber: dto.accountNumber,
          bankCode: dto.bankCode,
          amount: dto.amount,
          label: dto.purpose,
          purposeLabel: dto.purpose,
          purposeNote: dto.note,
          beneficiaryNickname: dto.nickname,
          surface: PaymentSurface.NATIVE,
          clientRequestKey: key,
        });
      } catch (err) {
        // Two first requests under one key: the loser's insert hits the
        // unique index, and is answered as the replay it is.
        if (isUniqueViolation(err)) {
          const winner = await this.findByKey(principal.userId, key);
          if (winner) {
            return { replayed: true, view: await this.replay(winner, dto) };
          }
        }
        throw err;
      }

      if (!result.ok) {
        throw result.reason === "no_account"
          ? new ConflictException({ error: "no_account" })
          : new UnprocessableEntityException({ error: "recipient_unverified" });
      }

      const fee = result.evaluation.feeAmount;
      return {
        replayed: false,
        view: {
          transfer: await this.view({
            ...result.transaction,
            recipient: result.recipient,
          }),
          isNewRecipient: result.isNewRecipient,
          balanceAfter:
            result.balance === null
              ? null
              : naira(result.balance - dto.amount - fee),
          allowanceLeftToday: naira(
            result.evaluation.remainingToday - dto.amount,
          ),
        },
      };
    });
  }

  confirm(principal: AppPrincipal, id: string): Promise<ConfirmView> {
    return inApp(principal, async () => {
      const decision = await this.transfers.evaluateConfirm(
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
          const { transaction } = decision;
          if (transaction.status === TransactionStatus.PENDING_PIN) {
            return {
              decision: "pin_required",
              transfer: await this.load(principal.userId, id),
              pinToken: await this.pinGate.issueTransferPinToken(
                transaction.user,
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
            transfer: await this.load(principal.userId, id),
            needed: decision.needed,
            balance: decision.balance,
          };
        case "requoted": {
          const amount = Number(decision.transaction.amount);
          return {
            decision: "requoted",
            transfer: await this.load(principal.userId, id),
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
            transfer: await this.load(principal.userId, id),
            setupToken: await this.pinGate.issuePinSetupToken(
              decision.transaction.user,
            ),
          };
        case "locked":
          return {
            decision: "locked",
            transfer: await this.load(principal.userId, id),
            lockedUntil:
              decision.transaction.user.pinLockedUntil?.toISOString() ?? null,
          };
        case "pin_required":
          return {
            decision: "pin_required",
            transfer: await this.load(principal.userId, id),
            pinToken: await this.pinGate.issueTransferPinToken(
              decision.transaction.user,
              id,
            ),
          };
      }
    });
  }

  /**
   * The PIN. Checked only while the transfer is waiting for one, so a PIN
   * sent for a cancelled or finished transfer is not spent as an attempt.
   */
  authorize(
    principal: AppPrincipal,
    id: string,
    dto: AuthorizeTransferDto,
  ): Promise<AuthorizeView> {
    return inApp(principal, async () => {
      const row = await this.row(principal.userId, id, PaymentSurface.NATIVE);
      if (!row) throw new NotFoundException({ error: "not_found" });
      if (row.status !== TransactionStatus.PENDING_PIN) {
        throw new ConflictException({
          error: "not_awaiting_pin",
          status: paymentStatus(row.status),
        });
      }

      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
      });
      const check = await this.pinGate.authorizeTransfer(
        user,
        dto.pinToken,
        id,
        dto.pin,
      );
      switch (check.kind) {
        case "expired":
          return { result: "expired", transfer: await this.view(row) };
        case "wrong_pin":
          return {
            result: "wrong_pin",
            transfer: await this.view(row),
            message: check.message,
            retryToken: check.retryToken,
          };
        case "locked":
          return {
            result: "locked",
            transfer: await this.load(principal.userId, id),
            message: check.message,
          };
        case "verified": {
          const applied = await this.pinOutcome.apply(
            check.outcome,
            principal.userId,
            { quiet: true },
          );
          const transfer = await this.load(principal.userId, id);
          if (applied.kind === "capped") {
            return {
              result: "cap_exceeded",
              transfer,
              cap: {
                cap: applied.cap,
                remaining: applied.remaining,
                liftsAt: applied.liftsAt.toISOString(),
              },
            };
          }
          const result =
            transfer.status === "successful" ||
            transfer.status === "failed" ||
            transfer.status === "processing"
              ? transfer.status
              : // Cancelled between the PIN check and the claim to send.
                "expired";
          return { result, transfer };
        }
      }
    });
  }

  async get(principal: AppPrincipal, id: string): Promise<TransferView> {
    return this.load(principal.userId, id);
  }

  async cancel(principal: AppPrincipal, id: string): Promise<TransferView> {
    const cancelled = await this.transfers.withdraw(principal.userId, id);
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
  ): Promise<TransferRow | null> {
    return this.prisma.transaction.findUnique({
      where: { userId_clientRequestKey: { userId, clientRequestKey } },
      include: { recipient: true },
    });
  }

  private async replay(
    row: TransferRow,
    dto: CreateTransferDto,
  ): Promise<QuoteView> {
    if (
      row.recipient.accountNumber !== dto.accountNumber ||
      row.recipient.bankCode !== dto.bankCode ||
      Number(row.amount) !== dto.amount
    ) {
      throw new UnprocessableEntityException({
        error: "idempotency_key_reused",
      });
    }
    const transfer = await this.view(row);
    if (row.status !== TransactionStatus.PENDING_CONFIRMATION) {
      return {
        transfer,
        isNewRecipient: false,
        balanceAfter: null,
        allowanceLeftToday: null,
      };
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
      transfer,
      isNewRecipient: false,
      balanceAfter:
        balance === null
          ? null
          : naira(balance - amount - Number(row.feeAmount)),
      allowanceLeftToday: naira(summary.remainingToday - amount),
    };
  }

  /** The caller's own transfer, from either surface; null otherwise. */
  private row(
    userId: string,
    id: string,
    surface?: PaymentSurface,
  ): Promise<TransferRow | null> {
    return this.prisma.transaction.findFirst({
      where: { id, userId, ...(surface ? { originSurface: surface } : {}) },
      include: { recipient: true },
    });
  }

  private async load(userId: string, id: string): Promise<TransferView> {
    const row = await this.row(userId, id);
    if (!row) throw new NotFoundException({ error: "not_found" });
    return this.view(row);
  }

  private async view(row: TransferRow): Promise<TransferView> {
    const fee = Number(row.feeAmount);
    const names = await this.banks.names();
    return {
      id: row.id,
      status: paymentStatus(row.status),
      amount: Number(row.amount),
      fee,
      spendType: row.type,
      feeNote: feeNote(row.type, fee),
      purpose: row.purposeLabel,
      recipient: {
        accountName: row.recipient.accountName,
        nickname: row.recipient.nickname,
        accountNumber: row.recipient.accountNumber,
        bankCode: row.recipient.bankCode,
        bankName: names.get(row.recipient.bankCode) ?? null,
      },
      surface: surfaceOf(row.originSurface),
      createdAt: row.createdAt.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      executedAt: row.executedAt?.toISOString() ?? null,
    };
  }
}
