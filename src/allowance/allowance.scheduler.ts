import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "./allowance.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { NudgeType, User } from "@prisma/client";

const FREE_FORM_WINDOW_MS = 24 * 60 * 60 * 1000; // Meta blocks free-form sends past 24h since the user's last inbound message

/**
 * Allowance rows are created lazily on first check-in (see
 * AllowanceService.getOrCreateTodayAllowance), so the midnight job here is
 * mostly a safety net. Also home to the window-open proactive nudge (PRD
 * §13) — explicitly post-v0 per the build-out plan (not a §4.1 must-have),
 * included because the NudgeLog schema and this scheduler already exist and
 * the marginal cost is low.
 */
@Injectable()
export class AllowanceScheduler {
  private readonly logger = new Logger(AllowanceScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /** "Active" here just means "has a Rubies account" — the only notion of an onboarded user this schema has. */
  private findActiveUsers(extraWhere: Record<string, unknown> = {}) {
    return this.prisma.user.findMany({
      where: { rubiesAccountNumber: { not: null }, ...extraWhere },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyBoundary() {
    const activeUsers = await this.findActiveUsers();
    this.logger.log(
      `Daily boundary: pre-warming allowances for ${activeUsers.length} active user(s)`,
    );
    for (const user of activeUsers) {
      try {
        await this.allowance.getOrCreateTodayAllowance(user.id);
      } catch (err) {
        this.logger.error(
          `Failed to pre-warm allowance for user ${user.id}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Fires once per user per calendar day, at their own windowStartHour
   * (per-user overridable, defaults to 11 per DAILY_WINDOW_START_HOUR).
   * NudgeLog is the dedup key so a scheduler restart or overlapping tick
   * can't double-send.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendWindowOpenNudges() {
    const now = new Date();
    const hour = now.getHours();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const dueUsers = await this.findActiveUsers({ windowStartHour: hour });
    if (dueUsers.length === 0) return;

    for (const user of dueUsers) {
      const alreadySent = await this.prisma.nudgeLog.findFirst({
        where: {
          userId: user.id,
          type: NudgeType.WINDOW_OPEN,
          sentAt: { gte: today },
        },
      });
      if (alreadySent) continue;

      try {
        await this.sendNudge(
          user,
          NudgeType.WINDOW_OPEN,
          "Your day is unlocked - today's allowance is ready to spend.",
        );
      } catch (err) {
        this.logger.error(
          `Failed to send window-open nudge to user ${user.id}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Onboarding script Stage 13 (Habit-Forming Follow-Up, "~10 hours later").
   * A rolling 10-11h window rather than an exact scheduled fire time — this
   * runs hourly, so anyone whose onboardingCompletedAt falls in the window
   * on a given tick gets caught; NudgeLog dedup (no `sentAt` time-bound,
   * unlike the daily WINDOW_OPEN nudge) makes this a true once-ever send.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendHabitFormingFollowUps() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 11 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() - 10 * 60 * 60 * 1000);

    const dueUsers = await this.prisma.user.findMany({
      where: { onboardingCompletedAt: { gte: windowStart, lte: windowEnd } },
    });
    if (dueUsers.length === 0) return;

    const text = [
      "one thing that makes udara work better: remove easy access to the old habits.",
      "consider:\n- removing saved cards from shopping apps\n- reducing access to other banking apps\n- using udara as your main spending account",
      "udara works best when you design your environment to support your goals.",
    ].join("\n\n");

    for (const user of dueUsers) {
      const alreadySent = await this.prisma.nudgeLog.findFirst({
        where: { userId: user.id, type: NudgeType.HABIT_FORMING_FOLLOWUP },
      });
      if (alreadySent) continue;

      try {
        await this.sendNudge(user, NudgeType.HABIT_FORMING_FOLLOWUP, text);
      } catch (err) {
        this.logger.error(
          `Failed to send habit-forming follow-up to user ${user.id}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * WhatsApp free-form sends are blocked more than 24h after the user's last
   * inbound message — falls back to a pre-approved template in that case, or
   * skips (loudly logged, not silently) if no template name is configured.
   */
  private async sendNudge(
    user: User,
    type: NudgeType,
    text: string,
  ): Promise<void> {
    const withinFreeFormWindow =
      !!user.lastInboundMessageAt &&
      Date.now() - user.lastInboundMessageAt.getTime() < FREE_FORM_WINDOW_MS;

    if (withinFreeFormWindow) {
      await this.whatsapp.sendText(user.whatsappNumber, text, user.id);
      await this.prisma.nudgeLog.create({
        data: { userId: user.id, type, channel: "freeform" },
      });
      return;
    }

    const templateName = this.config.get<string>(
      "WHATSAPP_WINDOW_OPEN_TEMPLATE_NAME",
    );
    if (!templateName) {
      this.logger.warn(
        `Skipping ${type} nudge for user ${user.id} — outside the 24h free-form window and no template configured (WHATSAPP_WINDOW_OPEN_TEMPLATE_NAME)`,
      );
      return;
    }

    await this.whatsapp.sendTemplate(
      user.whatsappNumber,
      templateName,
      "en_US",
      undefined,
      user.id,
    );
    await this.prisma.nudgeLog.create({
      data: { userId: user.id, type, channel: "template", templateName },
    });
  }
}
