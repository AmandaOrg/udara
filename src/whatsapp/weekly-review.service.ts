import { Injectable, Logger } from "@nestjs/common";
import { Prisma, User, WeeklyReview, WeeklyReviewStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import { WhatsappService } from "./whatsapp.service";
import { ChunkedMessengerService } from "./chunked-messenger.service";
import {
  startOfWatIsoWeekInstant,
  watDateBucketKey,
} from "../common/wat-time.util";
import { displayFirstNameOrThere } from "../common/display-name.util";
import { parseNairaAmount } from "../common/naira-amount.util";

export const WEEKLY_REVIEW_PREFIX = "weekly:";
export const WEEKLY_KEEP = "weekly:keep";
export const WEEKLY_ADJUST = "weekly:adjust";

/**
 * Bounds on a self-served weekly limit change. Deliberately permissive at the
 * bottom (someone tightening their own limit is the behaviour this product
 * exists to encourage) and capped at the top relative to the derived plan, so
 * "adjust my limits" can't quietly become "switch the discipline off". A user
 * who genuinely wants more than this goes through the Manager cooling-off
 * path, which is what that path is for.
 */
const MIN_DAILY_LIMIT = 100;
const MAX_MULTIPLE_OF_PLAN = 2;

const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-NG")}`;

/**
 * The Sunday in-chat weekly review: a spend recap, then an explicit choice
 * between keeping the current limits and setting a different daily limit for
 * the week ahead.
 *
 * An adjustment applies to ONE WAT ISO week and then lapses (see
 * User.dailyLimitOverride / AllowanceService.computeDailyAmount). That is the
 * point: a weekly review that silently rewrote the plan permanently would let
 * a run of "just this week" decisions drift the user off their 30% allocation
 * without anyone ever deciding to.
 */
@Injectable()
export class WeeklyReviewService {
  private readonly logger = new Logger(WeeklyReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly spendSummary: SpendSummaryService,
    private readonly whatsapp: WhatsappService,
    private readonly chunkedMessenger: ChunkedMessengerService,
  ) {}

  /**
   * The review the router should treat the next inbound text as an answer to,
   * or null. Only AWAITING_LIMIT qualifies: a review sitting at SENT is
   * waiting on a button, and free text then should behave normally rather
   * than being swallowed as a limit.
   */
  async getReviewAwaitingLimit(userId: string): Promise<WeeklyReview | null> {
    return this.prisma.weeklyReview.findFirst({
      where: { userId, status: WeeklyReviewStatus.AWAITING_LIMIT },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Sends the recap for the week just finished. Returns false if this user
   * already has a review for this week, which is what makes the Sunday
   * scheduler safe to re-run: the unique [userId, weekStartDate] index is the
   * dedup, not a time check.
   */
  async sendReview(user: User, now: Date = new Date()): Promise<boolean> {
    const weekStartDate = watDateBucketKey(startOfWatIsoWeekInstant(now));

    const summary = await this.spendSummary.getWeeklySummary(user.id, now);
    const todayAllowance = await this.allowance.getOrCreateTodayAllowance(
      user.id,
    );
    const dailyLimit = Number(todayAllowance.amountAllocated);
    const weeklyLimit = dailyLimit * 7;

    try {
      await this.prisma.weeklyReview.create({
        data: {
          userId: user.id,
          weekStartDate,
          totalSpent: summary.totalSpent,
          status: WeeklyReviewStatus.SENT,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        this.logger.debug(
          `Weekly review already sent to user ${user.id} for week ${weekStartDate.toISOString().slice(0, 10)}`,
        );
        return false;
      }
      throw err;
    }

    const firstName = displayFirstNameOrThere(user.name);
    const lines = [`${firstName}, here's how your week went.`];

    if (summary.transactionCount === 0) {
      lines.push(
        "you didn't spend anything through udara this week. either that was real discipline, or the spending happened somewhere i can't see. worth being honest with yourself about which.",
      );
    } else {
      lines.push(
        `you spent ${naira(summary.totalSpent)} across ${summary.transactionCount} transaction${summary.transactionCount === 1 ? "" : "s"}, out of a ${naira(weeklyLimit)} weekly allowance.`,
      );

      const labelEntries = Object.entries(summary.byLabel).sort(
        (a, b) => Number(b[1]) - Number(a[1]),
      );
      if (labelEntries.length > 0) {
        lines.push(
          "where it went:\n" +
            labelEntries
              .map(
                ([label, amount]) =>
                  `${label.toLowerCase()}: ${naira(Number(amount))}`,
              )
              .join("\n"),
        );
      }

      const remaining = weeklyLimit - summary.totalSpent;
      lines.push(
        remaining >= 0
          ? `you stayed inside your limit, with ${naira(remaining)} to spare.`
          : `you went over by ${naira(-remaining)}.`,
      );
    }

    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      lines.join("\n\n"),
      user.id,
    );

    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      `your daily limit is ${naira(dailyLimit)}. want to keep it for the week ahead, or change it?`,
      [
        { id: WEEKLY_KEEP, title: "Keep same limits" },
        { id: WEEKLY_ADJUST, title: "Adjust limits" },
      ],
      user.id,
    );

    return true;
  }

  /** Handles the keep/adjust button. */
  async handleChoice(user: User, buttonId: string): Promise<void> {
    const review = await this.prisma.weeklyReview.findFirst({
      where: { userId: user.id, status: WeeklyReviewStatus.SENT },
      orderBy: { createdAt: "desc" },
    });
    if (!review) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        'that weekly check-in has already been answered. say "limits" any time to see where you stand.',
        user.id,
      );
      return;
    }

    if (buttonId === WEEKLY_KEEP) {
      await this.prisma.weeklyReview.update({
        where: { id: review.id },
        data: {
          status: WeeklyReviewStatus.COMPLETED,
          respondedAt: new Date(),
        },
      });
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "good, we keep the same limits. i'll check in again next sunday.",
        user.id,
      );
      return;
    }

    if (buttonId === WEEKLY_ADJUST) {
      await this.prisma.weeklyReview.update({
        where: { id: review.id },
        data: { status: WeeklyReviewStatus.AWAITING_LIMIT },
      });
      const todayAllowance = await this.allowance.getOrCreateTodayAllowance(
        user.id,
      );
      const current = Number(todayAllowance.amountAllocated);
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `what daily limit do you want for this week? it's ${naira(current)} right now. just send the number.\n\nthis applies to the coming week only, then it goes back to your normal plan.`,
        user.id,
      );
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "tap one of the options above.",
      user.id,
    );
  }

  /**
   * Handles the free-text amount after "Adjust limits". Rejections leave the
   * review in AWAITING_LIMIT so the user can simply try again.
   */
  async handleLimitText(
    user: User,
    review: WeeklyReview,
    text: string,
    now: Date = new Date(),
  ): Promise<void> {
    const amount = parseNairaAmount(text);

    if (amount == null) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that didn't read as an amount. how much a day should I work with?",
        user.id,
      );
      return;
    }

    if (amount < MIN_DAILY_LIMIT) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `${naira(amount)} a day is too low to be workable. give me something from ${naira(MIN_DAILY_LIMIT)} up.`,
        user.id,
      );
      return;
    }

    // Ceiling is relative to the *derived* plan, not the current effective
    // limit, so successive weekly adjustments can't ratchet upward off each
    // other's raised baseline.
    const planned = this.allowance.computePlannedDailyAmount(user);
    const ceiling = planned * MAX_MULTIPLE_OF_PLAN;
    if (planned > 0 && amount > ceiling) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `${naira(amount)} a day is more than double your plan (${naira(planned)}). i can go up to ${naira(ceiling)} here. if you need more than that, ask me to raise your limit properly and we'll talk it through.`,
        user.id,
      );
      return;
    }

    // The override targets the week *containing* now. The review is sent on
    // Sunday, which is the last day of the WAT ISO week, so the user is
    // choosing for the week that starts tomorrow.
    const nextWeek = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const overrideWeek = watDateBucketKey(startOfWatIsoWeekInstant(nextWeek));

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        dailyLimitOverride: amount,
        dailyLimitOverrideWeekStart: overrideWeek,
      },
    });
    await this.prisma.weeklyReview.update({
      where: { id: review.id },
      data: {
        status: WeeklyReviewStatus.COMPLETED,
        newDailyLimit: amount,
        respondedAt: new Date(),
      },
    });

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `done. ${naira(amount)} a day, ${naira(amount * 7)} for the week. this is just for this week, then you're back to your normal plan.`,
      user.id,
    );
  }
}
