import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { EmailNotificationsService } from "./email-notifications.service";
import { getWatDateParts, getWatHour } from "../common/wat-time.util";

/** WAT wall-clock hour the recap emails go out. */
const SUMMARY_SEND_HOUR = 9;

/**
 * Weekly and monthly recap emails.
 *
 * Runs hourly and checks the WAT wall-clock itself rather than relying on a
 * cron expression's own notion of "Monday 9am": @nestjs/schedule evaluates
 * crons in the *process* timezone, which is UTC on the deployment host and
 * WAT on a dev machine, so a plain `0 9 * * 1` would fire at different local
 * times in each. Same pattern as AllowanceScheduler.sendWindowOpenNudges.
 *
 * Idempotency lives in EmailLog's unique dedupeKey, not here, so a restart,
 * an overlapping tick, or a redeploy mid-hour cannot produce a second send.
 */
@Injectable()
export class EmailScheduler {
  private readonly logger = new Logger(EmailScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  private findActiveUsers() {
    return this.prisma.user.findMany({
      // Closed accounts keep their account number as a record (ADR-0003).
      where: { rubiesAccountNumber: { not: null }, closedAt: null },
    });
  }

  /** Mondays at 9am WAT: the week just finished. */
  @Cron(CronExpression.EVERY_HOUR)
  async sendWeeklySummaries() {
    const now = new Date();
    if (getWatHour(now) !== SUMMARY_SEND_HOUR) return;
    if (watWeekday(now) !== 1) return; // 1 = Monday

    const users = await this.findActiveUsers();
    this.logger.log(`Weekly summary email: ${users.length} active user(s)`);
    for (const user of users) {
      // Per-user, because one throw used to abort the whole tick and
      // everyone after that user simply never got their summary.
      try {
        await this.emailNotifications.sendWeeklySummary(user, now);
      } catch (err) {
        this.logger.error(
          `weekly summary failed for user ${user.id}: ${String(err)}`,
        );
      }
    }
  }

  /** The 1st of each month at 9am WAT. */
  @Cron(CronExpression.EVERY_HOUR)
  async sendMonthlySummaries() {
    const now = new Date();
    if (getWatHour(now) !== SUMMARY_SEND_HOUR) return;
    if (getWatDateParts(now).day !== 1) return;

    const users = await this.findActiveUsers();
    this.logger.log(`Monthly summary email: ${users.length} active user(s)`);
    for (const user of users) {
      // Per-user, because one throw used to abort the whole tick and
      // everyone after that user simply never got their summary.
      try {
        await this.emailNotifications.sendMonthlySummary(user, now);
      } catch (err) {
        this.logger.error(
          `monthly summary failed for user ${user.id}: ${String(err)}`,
        );
      }
    }
  }
}

/** Day of week (0 = Sunday) for the WAT calendar date of an instant. */
export function watWeekday(date: Date): number {
  const { year, month, day } = getWatDateParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
