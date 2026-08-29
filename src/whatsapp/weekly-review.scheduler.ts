import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { WeeklyReviewService } from "./weekly-review.service";
import { getWatHour } from "../common/wat-time.util";
import { watWeekday } from "../email/email.scheduler";

/** WAT wall-clock hour the Sunday recap goes out. */
const REVIEW_SEND_HOUR = 18;

/**
 * Sunday evening in-chat weekly review. Hour/day are checked against the WAT
 * wall clock rather than expressed in the cron itself, because
 * @nestjs/schedule evaluates crons in the process timezone (UTC on the
 * deployment host) — the same reason AllowanceScheduler works this way.
 *
 * Dedup is WeeklyReview's unique [userId, weekStartDate] index, applied
 * inside sendReview, so a restart or overlapping tick cannot double-send.
 */
@Injectable()
export class WeeklyReviewScheduler {
  private readonly logger = new Logger(WeeklyReviewScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly weeklyReview: WeeklyReviewService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sendSundayReviews() {
    const now = new Date();
    if (watWeekday(now) !== 0) return; // 0 = Sunday
    if (getWatHour(now) !== REVIEW_SEND_HOUR) return;

    const users = await this.prisma.user.findMany({
      where: { rubiesAccountNumber: { not: null } },
    });
    if (users.length === 0) return;

    this.logger.log(`Sunday weekly review: ${users.length} active user(s)`);
    for (const user of users) {
      try {
        await this.weeklyReview.sendReview(user, now);
      } catch (err) {
        this.logger.error(
          `Failed to send weekly review to user ${user.id}: ${String(err)}`,
        );
      }
    }
  }
}
