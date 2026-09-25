import { Injectable, Logger } from "@nestjs/common";
import { Prisma, User, WeeklyReview, WeeklyReviewStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import {
  startOfWatIsoWeekInstant,
  watDateBucketKey,
} from "../common/wat-time.util";
import { displayFirstNameOrThere } from "../common/display-name.util";

/** Udara starts this conversation; nobody asked. */
const PROACTIVE = { delivery: "proactive" } as const;

export const WEEKLY_REVIEW_PREFIX = "weekly:";
export const WEEKLY_KEEP = "weekly:keep";
export const WEEKLY_ADJUST = "weekly:adjust";

/** After this, an unanswered Adjust no longer swallows chat. */
const DAY_MS = 24 * 60 * 60 * 1000;
export const AWAITING_LIMIT_TTL_MS = DAY_MS;

/**
 * One string for "we're keeping your limits as they are". The Keep button and
 * the abandon path both say this; they used to say two slightly different
 * things for the same outcome.
 */
export const KEEP_LIMITS_ACK =
  "okay, we'll keep the current limits. i'll check in again next sunday.";

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
    private readonly messenger: ChannelMessenger,
  ) {}

  /**
   * The review the router should treat a parseable amount as an answer to,
   * or null. Only AWAITING_LIMIT qualifies: a review sitting at SENT is
   * waiting on a button, and free text then should behave normally rather
   * than being swallowed as a limit. Stale waits are completed with no
   * override so they cannot trap chat into the next day.
   */
  async getReviewAwaitingLimit(
    userId: string,
    now: Date = new Date(),
  ): Promise<WeeklyReview | null> {
    // Expiry is a filter, not a write. Doing it as read-then-write made a
    // getter mutate state, and left a race where a concurrent retry could
    // re-arm a review another message had just closed. A stale row is simply
    // invisible to routing, which is all the TTL was ever for; the Sunday
    // sweep in sendReview tidies it up.
    return this.prisma.weeklyReview.findFirst({
      where: {
        userId,
        status: WeeklyReviewStatus.AWAITING_LIMIT,
        updatedAt: { gt: new Date(now.getTime() - AWAITING_LIMIT_TTL_MS) },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Drops an unanswered Adjust, and always says so.
   *
   * The silent version of this was the worst bug in the flow: a user tapped
   * "Adjust limits", typed something we could not read as a number, and the
   * whole thing evaporated — no override, no message, and a re-tap of the
   * button answering "that check-in has already been answered". Being told
   * costs one line and removes the entire class of "did that work?".
   */
  async abandonAwaitingLimit(
    user: User,
    review: WeeklyReview,
    now: Date = new Date(),
  ): Promise<void> {
    if (!(await this.completeWithoutOverride(review, now))) return;
    await this.messenger.sendText(user, KEEP_LIMITS_ACK);
  }

  /**
   * Sends the recap for the week just finished. Returns false if this user
   * already has a review for this week, which is what makes the Sunday
   * scheduler safe to re-run: the unique [userId, weekStartDate] index is the
   * dedup, not a time check.
   */
  async sendReview(user: User, now: Date = new Date()): Promise<boolean> {
    const weekStartDate = watDateBucketKey(startOfWatIsoWeekInstant(now));

    await this.prisma.weeklyReview.updateMany({
      where: {
        userId: user.id,
        status: WeeklyReviewStatus.AWAITING_LIMIT,
        weekStartDate: { not: weekStartDate },
      },
      data: {
        status: WeeklyReviewStatus.COMPLETED,
        respondedAt: now,
      },
    });

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

    await this.messenger.sendChunked(user, lines.join("\n\n"), PROACTIVE);

    await this.messenger.sendButtons(
      user,
      `your daily limit is ${naira(dailyLimit)}. want to keep it for the week ahead, or change it?`,
      [
        { id: WEEKLY_KEEP, title: "Keep same limits" },
        { id: WEEKLY_ADJUST, title: "Adjust limits" },
      ],
      PROACTIVE,
    );

    return true;
  }

  /** Handles the keep/adjust button. */
  async handleChoice(
    user: User,
    buttonId: string,
    now: Date = new Date(),
  ): Promise<void> {
    // Only this week's review is answerable. An untapped bubble from a previous
    // Sunday stayed live indefinitely, so tapping "Adjust" on it on a Saturday
    // set an override for a week with one day left in it, which then lapsed
    // immediately — the user's intended change silently did nothing.
    const review = await this.prisma.weeklyReview.findFirst({
      where: {
        userId: user.id,
        status: WeeklyReviewStatus.SENT,
        weekStartDate: watDateBucketKey(startOfWatIsoWeekInstant(now)),
      },
      orderBy: { createdAt: "desc" },
    });
    if (!review) {
      await this.messenger.sendText(
        user,
        'that weekly check-in has already been answered. say "limits" any time to see where you stand.',
      );
      return;
    }

    if (buttonId === WEEKLY_KEEP) {
      if (!(await this.completeWithoutOverride(review, now))) return;
      await this.messenger.sendText(user, KEEP_LIMITS_ACK);
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
      await this.messenger.sendText(
        user,
        `what daily limit do you want for this week? it's ${naira(current)} right now. just send the number.\n\nthis applies to the coming week only, then it goes back to your normal plan.`,
      );
      return;
    }

    await this.messenger.sendText(user, "tap one of the options above.");
  }

  /**
   * Applies an amount the user gave after "Adjust limits".
   *
   * Takes the parsed number, not the raw text: the router has already read it,
   * and parsing twice meant a dead `amount == null` branch here that no
   * production caller could reach while its copy and its test were still
   * maintained as if they were live.
   */
  async handleLimitAmount(
    user: User,
    review: WeeklyReview,
    amount: number,
    now: Date = new Date(),
  ): Promise<void> {
    // Ceiling is relative to the *derived* plan, not the current effective
    // limit, so successive weekly adjustments can't ratchet upward off each
    // other's raised baseline.
    const planned = this.allowance.computePlannedDailyAmount(user);
    const ceiling = planned * MAX_MULTIPLE_OF_PLAN;

    const rejection =
      amount < MIN_DAILY_LIMIT
        ? `${naira(amount)} a day is too low to be workable. give me something from ${naira(MIN_DAILY_LIMIT)} up.`
        : planned > 0 && amount > ceiling
          ? `${naira(amount)} a day is more than double your plan (${naira(planned)}). i can go up to ${naira(ceiling)} here. if you need more than that, ask me to raise your limit properly and we'll talk it through.`
          : null;

    if (rejection) {
      // One touch, one send. Three separate rejection branches each had to
      // remember to bump the row first, and a fourth would have forgotten.
      await this.touchAwaitingLimit(review);
      await this.messenger.sendText(user, rejection);
      return;
    }

    // The review is sent on Sunday, the last day of the WAT ISO week, so the
    // user is normally choosing for the week starting tomorrow. But the wait
    // stays open into Monday, and an answer given then is about *this* week.
    const nextWeek = new Date(now.getTime() + DAY_MS);
    const overrideWeek = watDateBucketKey(startOfWatIsoWeekInstant(nextWeek));
    const currentWeek = watDateBucketKey(startOfWatIsoWeekInstant(now));
    const appliesToday = overrideWeek.getTime() === currentWeek.getTime();

    const claimed = await this.prisma.weeklyReview.updateMany({
      where: { id: review.id, status: WeeklyReviewStatus.AWAITING_LIMIT },
      data: {
        status: WeeklyReviewStatus.COMPLETED,
        newDailyLimit: amount,
        respondedAt: now,
      },
    });
    if (claimed.count === 0) return; // answered concurrently

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        dailyLimitOverride: amount,
        dailyLimitOverrideWeekStart: overrideWeek,
      },
    });

    // An answer that lands on Monday targets the week already in progress, and
    // today's allowance row was created at the boundary from the *old* plan.
    // getOrCreateTodayAllowance returns an existing row untouched, so without
    // this the user was told "done, ₦7,000 a day" while today stayed at the old
    // figure.
    const daysLeft = appliesToday
      ? await this.allowance.applyLimitOverrideToToday(user.id, amount, now)
      : 7;

    await this.messenger.sendText(
      user,
      `done. ${naira(amount)} a day, ${naira(amount * daysLeft)} for the ${daysLeft === 7 ? "week" : `${daysLeft} days left this week`}. this is just for this week, then you're back to your normal plan.`,
    );
  }

  /** Returns false when another caller already completed this review. */
  private async completeWithoutOverride(
    review: WeeklyReview,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.weeklyReview.updateMany({
      where: {
        id: review.id,
        status: {
          in: [WeeklyReviewStatus.SENT, WeeklyReviewStatus.AWAITING_LIMIT],
        },
      },
      data: {
        status: WeeklyReviewStatus.COMPLETED,
        respondedAt: now,
      },
    });
    return count > 0;
  }

  /**
   * Bumps `updatedAt` so a rejected retry resets the 24h wait.
   *
   * Writes an explicit `respondedAt: null` rather than re-writing the status
   * the row already has. The status echo worked only because Prisma issues the
   * UPDATE regardless, which made the whole TTL depend on an ORM implementation
   * detail; a future "skip unchanged writes" optimisation would have silently
   * broken it.
   */
  private async touchAwaitingLimit(review: WeeklyReview): Promise<void> {
    await this.prisma.weeklyReview.updateMany({
      where: { id: review.id, status: WeeklyReviewStatus.AWAITING_LIMIT },
      data: { respondedAt: null },
    });
  }
}
