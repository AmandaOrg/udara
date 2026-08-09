import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Allowance rows are created lazily on first check-in (see
 * AllowanceService.getOrCreateTodayAllowance), so this job is mostly a safety
 * net + the place to send the proactive "your day is unlocked" nudge once
 * that's in scope. Keep this thin — the rollover/window math itself lives in
 * AllowanceService, not here.
 */
@Injectable()
export class AllowanceScheduler {
  private readonly logger = new Logger(AllowanceScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyBoundary() {
    this.logger.log('Daily boundary job running — TODO: pre-warm allowances, send unlock nudges');
    // TODO: for each active user, ensure today's DailyAllowance row exists
    // (or leave fully lazy) and optionally send a WhatsApp "today's allowance
    // is ready" message once the proactive-nudge feature (PRD #13) is built.
  }
}
