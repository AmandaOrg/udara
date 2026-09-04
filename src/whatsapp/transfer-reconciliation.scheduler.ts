import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { RubiesService } from "../rubies/rubies.service";
import { AllowanceService } from "../allowance/allowance.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { BillPaymentStatus } from "../prisma/bill-payment.enums";
import { TransactionStatus } from "@prisma/client";

const STUCK_AFTER_MS = 2 * 60 * 1000; // reconcile anything CONFIRMED for >~2 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back to keep chasing an unresolved row. Without a floor, a row that
 * Rubies can never resolve burns a slot in every tick forever; the batch cap
 * would then be permanently occupied by the same dead rows and genuinely new
 * ones at the tail would never be reached. Anything older is a human problem,
 * surfaced by the stale sweep below rather than retried silently.
 */
const GIVE_UP_AFTER_MS = 7 * DAY_MS;

/** Bounds a single tick. Ordered oldest-first so nothing starves. */
const BATCH_SIZE = 200;

/**
 * Safety nets for work that was started but never confirmed. Three independent
 * jobs rather than one, so an outage in one dependency cannot block the others:
 * the allowance repair is pure database work and must keep running even while
 * Rubies is unreachable.
 *
 * All of these re-enter TransferConfirmationService / BillPaymentConfirmationService,
 * whose status transitions are atomic claims, so a double run is harmless. That
 * is what makes these jobs safe to add.
 */
@Injectable()
export class TransferReconciliationScheduler {
  private readonly logger = new Logger(TransferReconciliationScheduler.name);

  /**
   * In-process overlap guards. Each tick does sequential network calls, so a
   * slow Rubies can easily push one past the next tick's start. This is
   * load-shedding, not correctness — correctness comes from the atomic claims,
   * since the webhook races these jobs regardless of what happens here.
   */
  private running = {
    transfers: false,
    bills: false,
    allowance: false,
    fees: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly allowance: AllowanceService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly billPaymentConfirmation: BillPaymentConfirmationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileStuckTransfers() {
    if (this.running.transfers) {
      this.logger.warn("transfer reconciliation still running — skipping tick");
      return;
    }
    this.running.transfers = true;
    try {
      const now = Date.now();
      const stuck = await this.prisma.transaction.findMany({
        where: {
          status: TransactionStatus.CONFIRMED,
          confirmedAt: {
            lte: new Date(now - STUCK_AFTER_MS),
            gte: new Date(now - GIVE_UP_AFTER_MS),
          },
        },
        orderBy: { confirmedAt: "asc" },
        take: BATCH_SIZE,
      });
      if (stuck.length === 0) return;

      this.logger.log(
        `Reconciling ${stuck.length} stuck-pending transfer(s) via TSQ`,
      );
      for (const transaction of stuck) {
        if (!transaction.idempotencyKey) {
          // Was a silent `continue`, which made these rows invisible: nothing can
          // ever resolve them, so they need to be said out loud.
          this.logger.error(
            `transaction ${transaction.id} is CONFIRMED with no idempotencyKey — cannot be reconciled, needs manual review`,
          );
          continue;
        }
        try {
          const result = await this.rubies.queryTransferStatus(
            transaction.idempotencyKey,
          );
          if (result.status === "PENDING") continue; // still unknown — try next tick
          await this.transferConfirmation.applyTransferResult(
            transaction.id,
            result.status,
            result.reference,
          );
        } catch (err) {
          this.logger.error(
            `TSQ reconciliation failed for transaction ${transaction.id}: ${String(err)}`,
          );
        }
      }
    } finally {
      this.running.transfers = false;
    }
  }

  /**
   * The bill-payment equivalent, which did not exist. A VAS purchase that came
   * back PENDING was left CONFIRMED forever unless the Rubies webhook happened
   * to arrive: the allowance was never debited and the user never heard back.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileStuckBillPayments() {
    if (this.running.bills) {
      this.logger.warn("bill reconciliation still running — skipping tick");
      return;
    }
    this.running.bills = true;
    try {
      const now = Date.now();
      const stuck = await this.prisma.billPayment.findMany({
        where: {
          status: BillPaymentStatus.CONFIRMED,
          confirmedAt: {
            lte: new Date(now - STUCK_AFTER_MS),
            gte: new Date(now - GIVE_UP_AFTER_MS),
          },
        },
        orderBy: { confirmedAt: "asc" },
        take: BATCH_SIZE,
      });
      if (stuck.length === 0) return;

      this.logger.log(
        `Reconciling ${stuck.length} stuck-pending bill payment(s)`,
      );
      for (const payment of stuck) {
        const reference = payment.requestReference ?? payment.idempotencyKey;
        if (!reference) {
          this.logger.error(
            `bill payment ${payment.id} is CONFIRMED with no reference — cannot be reconciled, needs manual review`,
          );
          continue;
        }
        try {
          const result = await this.rubies.queryVasTransaction(reference);
          if (result.status === "PENDING") continue;
          await this.billPaymentConfirmation.applyBillPaymentResult(
            payment.id,
            result.status,
            result.reference,
            result.vendorToken,
          );
        } catch (err) {
          this.logger.error(
            `VAS reconciliation failed for bill payment ${payment.id}: ${String(err)}`,
          );
        }
      }
    } finally {
      this.running.bills = false;
    }
  }

  /**
   * Money moved but the allowance never recorded it.
   *
   * applyTransferResult writes the terminal status first and then runs its side
   * effects, so anything that throws in between — a database blip, a unique
   * constraint — leaves an EXECUTED row with appliedToAllowanceAt still null.
   * Nothing revisited those, so the customer's daily limit silently under-counted
   * a spend that really happened, permanently.
   *
   * Pure database work, so this runs on its own cadence and keeps working while
   * Rubies is down.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async repairUnappliedSpend() {
    if (this.running.allowance) return;
    this.running.allowance = true;
    try {
      const since = new Date(Date.now() - GIVE_UP_AFTER_MS);
      const [transactions, billPayments] = await Promise.all([
        this.prisma.transaction.findMany({
          where: {
            status: TransactionStatus.EXECUTED,
            appliedToAllowanceAt: null,
            executedAt: { gte: since },
          },
          orderBy: { executedAt: "asc" },
          take: BATCH_SIZE,
        }),
        this.prisma.billPayment.findMany({
          where: {
            status: BillPaymentStatus.EXECUTED,
            appliedToAllowanceAt: null,
            executedAt: { gte: since },
          },
          orderBy: { executedAt: "asc" },
          take: BATCH_SIZE,
        }),
      ]);

      for (const transaction of transactions) {
        try {
          await this.allowance.recordSpend(transaction.id);
          this.logger.warn(
            `repaired unapplied allowance spend for transaction ${transaction.id}`,
          );
        } catch (err) {
          // A missing allowance row for that day is not retryable by this job —
          // log it as its own problem rather than re-throwing every 5 minutes.
          this.logger.error(
            `could not repair allowance spend for transaction ${transaction.id}: ${String(err)}`,
          );
        }
      }

      for (const payment of billPayments) {
        try {
          await this.allowance.recordBillPaymentSpend(payment.id);
          this.logger.warn(
            `repaired unapplied allowance spend for bill payment ${payment.id}`,
          );
        } catch (err) {
          this.logger.error(
            `could not repair allowance spend for bill payment ${payment.id}: ${String(err)}`,
          );
        }
      }
    } finally {
      this.running.allowance = false;
    }
  }

  /**
   * Override fees that were charged but never collected. Runs on a slower
   * cadence than the transfer jobs because the money is ours, not the
   * customer's, and each attempt is a real debit against their wallet.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryUnsweptFees() {
    if (this.running.fees) return;
    this.running.fees = true;
    try {
      await this.transferConfirmation.retryUnsweptFees();
    } catch (err) {
      this.logger.error(`fee sweep retry failed: ${String(err)}`);
    } finally {
      this.running.fees = false;
    }
  }

  /**
   * Anything still unresolved past the give-up horizon is invisible to the jobs
   * above, so say so once a day rather than letting it sit forever.
   */
  @Cron(CronExpression.EVERY_DAY_AT_NOON)
  async reportAbandonedWork() {
    const cutoff = new Date(Date.now() - GIVE_UP_AFTER_MS);
    const [transfers, bills, unapplied] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          status: TransactionStatus.CONFIRMED,
          confirmedAt: { lt: cutoff },
        },
      }),
      this.prisma.billPayment.count({
        where: {
          status: BillPaymentStatus.CONFIRMED,
          confirmedAt: { lt: cutoff },
        },
      }),
      this.prisma.transaction.count({
        where: {
          status: TransactionStatus.EXECUTED,
          appliedToAllowanceAt: null,
          executedAt: { lt: cutoff },
        },
      }),
    ]);

    if (transfers + bills + unapplied === 0) return;
    this.logger.error(
      `Unresolved past the ${GIVE_UP_AFTER_MS / DAY_MS}-day horizon and no longer retried: ` +
        `${transfers} transfer(s), ${bills} bill payment(s), ${unapplied} executed transfer(s) with no allowance applied. ` +
        `These need manual reconciliation.`,
    );
  }
}
