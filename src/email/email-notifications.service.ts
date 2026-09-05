import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmailType, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import { EmailService } from "./email.service";
import {
  formatPreviousWatMonthLabel,
  startOfWatIsoWeekInstant,
  startOfWatMonthInstant,
  watDateBucketKey,
} from "../common/wat-time.util";
import {
  pinResetOtpEmail,
  moneyInEmail,
  moneyOutEmail,
  monthlySummaryEmail,
  weeklySummaryEmail,
  windowOpenEmail,
} from "./email.templates";

/**
 * Composes the actual notification emails: gathers the figures, picks the
 * template, and hands EmailService an idempotency key.
 *
 * Every method here swallows its own errors. Callers are money-movement paths
 * (a Rubies webhook, a transfer completion) and scheduler ticks — none of
 * them should fail, roll back, or retry because an email didn't go out. The
 * failure is recorded on EmailLog and logged; the caller carries on.
 */
@Injectable()
export class EmailNotificationsService {
  private readonly logger = new Logger(EmailNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly allowance: AllowanceService,
    private readonly spendSummary: SpendSummaryService,
    private readonly config: ConfigService,
  ) {}

  /** Wraps a send so a failure can never escape into a money path. */
  private async safely(
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`${label} email failed: ${String(err)}`);
    }
  }

  /**
   * Keyed on the Rubies payment reference, which is already the dedup key for
   * the credit itself — a redelivered webhook produces the same key and is
   * refused by EmailLog's unique index.
   */
  async sendMoneyIn(params: {
    user: User;
    amount: number;
    rubiesReference: string;
    senderName?: string | null;
    balance?: number | null;
    receivedAt?: Date;
  }): Promise<void> {
    await this.safely("money-in", async () => {
      const { subject, html } = moneyInEmail({
        name: params.user.name,
        amount: params.amount,
        balance: params.balance,
        senderName: params.senderName,
        receivedAt: params.receivedAt ?? new Date(),
      });
      await this.email.send({
        userId: params.user.id,
        to: params.user.email,
        type: EmailType.MONEY_IN,
        subject,
        html,
        dedupeKey: `MONEY_IN:${params.rubiesReference}`,
      });
    });
  }

  /** Keyed on the transaction id, so webhook and reconciliation can't both send. */
  async sendMoneyOut(params: {
    user: User;
    transactionId: string;
    amount: number;
    feeAmount: number;
    recipientName: string;
    recipientAccount: string;
    bankName?: string | null;
    sentAt?: Date;
  }): Promise<void> {
    await this.safely("money-out", async () => {
      const { subject, html } = moneyOutEmail({
        name: params.user.name,
        amount: params.amount,
        feeAmount: params.feeAmount,
        recipientName: params.recipientName,
        recipientAccount: params.recipientAccount,
        bankName: params.bankName,
        sentAt: params.sentAt ?? new Date(),
      });
      await this.email.send({
        userId: params.user.id,
        to: params.user.email,
        type: EmailType.MONEY_OUT,
        subject,
        html,
        dedupeKey: `MONEY_OUT:${params.transactionId}`,
      });
    });
  }

  /**
   * The PIN-reset code. Unlike every other email here this one is NOT
   * best-effort: if it doesn't reach the user there is no reset, so the
   * caller needs to know and tell them rather than leaving them staring at a
   * form for a code that never arrives. Returns whether it was actually sent.
   *
   * Keyed on the challenge id, so each issued code emails exactly once.
   */
  async sendPinResetOtp(params: {
    user: User;
    otp: string;
    challengeId: string;
    expiresInMinutes: number;
  }): Promise<boolean> {
    const { subject, html } = pinResetOtpEmail({
      name: params.user.name,
      otp: params.otp,
      expiresInMinutes: params.expiresInMinutes,
    });
    const result = await this.email.send({
      userId: params.user.id,
      to: params.user.email,
      type: EmailType.PIN_RESET_OTP,
      subject,
      html,
      dedupeKey: `PIN_RESET:${params.challengeId}`,
    });
    return result.sent;
  }

  /** One per user per WAT calendar day, keyed on that date. */
  async sendWindowOpen(user: User, now: Date = new Date()): Promise<void> {
    await this.safely("window-open", async () => {
      const { remainingToday } = await this.allowance.getRemainingSummary(
        user.id,
      );
      const todayAllowance = await this.allowance.getOrCreateTodayAllowance(
        user.id,
      );
      const { subject, html } = windowOpenEmail({
        name: user.name,
        dailyLimit: Number(todayAllowance.amountAllocated),
        remainingToday,
        windowStartHour: user.windowStartHour,
        windowEndHour: user.windowEndHour,
      });
      await this.email.send({
        userId: user.id,
        to: user.email,
        type: EmailType.WINDOW_OPEN,
        subject,
        html,
        dedupeKey: `WINDOW_OPEN:${user.id}:${dateKey(now)}`,
      });
    });
  }

  /** One per user per WAT ISO week, keyed on that week's Monday. */
  async sendWeeklySummary(user: User, now: Date = new Date()): Promise<void> {
    await this.safely("weekly-summary", async () => {
      const summary = await this.spendSummary.getWeeklySummary(user.id, now);
      const todayAllowance = await this.allowance.getOrCreateTodayAllowance(
        user.id,
      );
      const { subject, html } = weeklySummaryEmail({
        name: user.name,
        periodLabel: "this week",
        totalSpent: summary.totalSpent,
        transactionCount: summary.transactionCount,
        byLabel: summary.byLabel,
        byDay: summary.byDay,
        allowanceForPeriod: Number(todayAllowance.amountAllocated) * 7,
      });
      await this.email.send({
        userId: user.id,
        to: user.email,
        type: EmailType.WEEKLY_SUMMARY,
        subject,
        html,
        dedupeKey: `WEEKLY:${user.id}:${dateKey(startOfWatIsoWeekInstant(now))}`,
      });
    });
  }

  /** One per user per WAT calendar month, keyed on that month's 1st. Recaps the month just finished. */
  async sendMonthlySummary(
    user: User,
    now: Date = new Date(),
    options?: { dedupeSuffix?: string },
  ): Promise<void> {
    await this.safely("monthly-summary", async () => {
      const summary = await this.spendSummary.getPreviousMonthSummary(
        user.id,
        now,
      );
      const todayAllowance = await this.allowance.getOrCreateTodayAllowance(
        user.id,
      );
      const dedupeKey = `MONTHLY:${user.id}:${dateKey(startOfWatMonthInstant(now))}${
        options?.dedupeSuffix ? `:${options.dedupeSuffix}` : ""
      }`;
      const { subject, html } = monthlySummaryEmail({
        name: user.name,
        periodLabel: formatPreviousWatMonthLabel(now),
        totalSpent: summary.totalSpent,
        transactionCount: summary.transactionCount,
        byLabel: summary.byLabel,
        // Deliberately no byDay for the month: 30 rows is a wall of numbers,
        // and the category breakdown is what makes a month legible.
        allowanceForPeriod: Number(todayAllowance.amountAllocated) * 30,
      });
      await this.email.send({
        userId: user.id,
        to: user.email,
        type: EmailType.MONTHLY_SUMMARY,
        subject,
        html,
        dedupeKey,
        headers: monthlySummaryListHeaders(this.config),
      });
    });
  }
}

/**
 * YYYY-MM-DD of an instant's WAT calendar date, for dedupe keys. Goes through
 * watDateBucketKey rather than toISOString directly: a true WAT-midnight
 * instant is UTC 23:00 the *previous* day, so formatting it as UTC would key
 * every week and month to the day before it actually starts, and would key a
 * just-after-midnight WAT send to yesterday.
 */
function dateKey(date: Date): string {
  return watDateBucketKey(date).toISOString().slice(0, 10);
}

/** Gmail/Outlook use this to offer one-click unsubscribe; improves inbox placement. */
function monthlySummaryListHeaders(
  config: ConfigService,
): Record<string, string> {
  const replyTo = config.get<string>("RESEND_REPLY_TO") ?? "hello@useudara.com";
  const mailto = `mailto:${replyTo}?subject=${encodeURIComponent("Unsubscribe monthly summary")}`;
  return {
    "List-Unsubscribe": `<${mailto}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
