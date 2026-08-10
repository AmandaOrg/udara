import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { RubiesService } from "../rubies/rubies.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { TransactionStatus } from "@prisma/client";

const STUCK_AFTER_MS = 2 * 60 * 1000; // per the build-out plan: reconcile anything CONFIRMED for >~2 minutes

/**
 * Safety net for a missed Rubies webhook (Phase 7): any Transaction that's
 * been CONFIRMED (Rubies call made, response was PENDING) for more than ~2
 * minutes gets its true status pulled via TSQ instead of waiting indefinitely
 * on a webhook that might never arrive. Shares
 * TransferConfirmationService.applyTransferResult with the confirm path
 * itself, so both are equally idempotent.
 */
@Injectable()
export class TransferReconciliationScheduler {
  private readonly logger = new Logger(TransferReconciliationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly transferConfirmation: TransferConfirmationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileStuckTransfers() {
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const stuck = await this.prisma.transaction.findMany({
      where: {
        status: TransactionStatus.CONFIRMED,
        confirmedAt: { lte: cutoff },
      },
    });
    if (stuck.length === 0) return;

    this.logger.log(
      `Reconciling ${stuck.length} stuck-pending transfer(s) via TSQ`,
    );
    for (const transaction of stuck) {
      if (!transaction.idempotencyKey) continue;
      try {
        const result = await this.rubies.queryTransferStatus(
          transaction.idempotencyKey,
        );
        if (result.status === "PENDING") continue; // still not known — try again next tick
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
  }
}
