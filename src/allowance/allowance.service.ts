import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { TransactionType } from "../common/enums/transaction-type.enum";
import { TransactionStatus, User } from "@prisma/client";
import {
  watDateBucketKey,
  startOfWatIsoWeekBucketKey,
} from "../common/wat-time.util";

@Injectable()
export class AllowanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly windowService: WindowService,
    private readonly feeCalculator: FeeCalculatorService,
  ) {}

  /**
   * Udara's universal budgeting formula (50/30/20 principle, Udara onboarding
   * script Stage 7): 30% of monthly income is the "wants" allowance Udara
   * actively manages day to day, split evenly across a fixed 30-day month —
   * not the actual calendar days in the current month — so that the figure
   * shown to the user at onboarding (dailyLimit * 30 === monthlyAllowance,
   * see OnboardingService.finalizeStructuredQuestions) never silently drifts
   * from what this method computes later. No income-tier branching: every
   * user gets the same formula, regardless of income level. Returns 0 if the
   * user hasn't been onboarded onto a plan yet (no monthlyIncome set) —
   * evaluateSpend still works, it just won't allow any NORMAL spend until a
   * plan exists.
   */
  computePlannedDailyAmount(user: Pick<User, "monthlyIncome">): number {
    if (!user.monthlyIncome) return 0;
    const WANTS_ALLOCATION_PCT = 0.3;
    return (Number(user.monthlyIncome) * WANTS_ALLOCATION_PCT) / 30;
  }

  /**
   * The daily figure actually in force: the derived plan above, unless the
   * user set a one-week override at their Sunday review (see
   * WeeklyReviewService). The override is honoured only for the WAT ISO week
   * it was set for, so it lapses on its own rather than quietly becoming the
   * new normal.
   */
  private computeDailyAmount(
    user: Pick<
      User,
      "monthlyIncome" | "dailyLimitOverride" | "dailyLimitOverrideWeekStart"
    >,
    now: Date = new Date(),
  ): number {
    if (user.dailyLimitOverride != null && user.dailyLimitOverrideWeekStart) {
      const currentWeek = startOfWatIsoWeekBucketKey(now);
      if (
        user.dailyLimitOverrideWeekStart.getTime() === currentWeek.getTime()
      ) {
        return Number(user.dailyLimitOverride);
      }
    }
    return this.computePlannedDailyAmount(user);
  }

  /**
   * Fetch or lazily create today's allowance row for a user. `now` is taken
   * once and threaded through, so the day bucket and the weekly-override
   * check can't disagree if the call straddles a WAT midnight.
   */
  async getOrCreateTodayAllowance(userId: string, now: Date = new Date()) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const today = watDateBucketKey(now);

    const existing = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: today } },
    });
    if (existing) return existing;

    const dailyAmount = this.computeDailyAmount(user, now);

    // today is a UTC-midnight bucket key (see watDateBucketKey) — step it
    // back a calendar day via the UTC setter, not the local one, or this
    // would silently reintroduce a process-timezone dependency.
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayAllowance = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: yesterday } },
    });

    const sameWeek =
      yesterdayAllowance &&
      startOfWatIsoWeekBucketKey(yesterdayAllowance.date).getTime() ===
        startOfWatIsoWeekBucketKey(today).getTime();

    const surplus =
      sameWeek && yesterdayAllowance
        ? Number(yesterdayAllowance.amountAllocated) +
          Number(yesterdayAllowance.surplusCarriedIn) -
          Number(yesterdayAllowance.amountSpent)
        : 0;

    return this.prisma.dailyAllowance.create({
      data: {
        userId,
        date: today,
        weekStartDate: startOfWatIsoWeekBucketKey(today),
        amountAllocated: dailyAmount,
        surplusCarriedIn: Math.max(surplus, 0),
      },
    });
  }

  /**
   * Today's and this week's remaining spendable figures. Extracted so the
   * two surfaces that report them — the deterministic "Limits" menu action
   * and the conversational persona's grounding context — compute them from
   * one place and can never quote different numbers for the same moment.
   */
  async getRemainingSummary(userId: string) {
    const allowance = await this.getOrCreateTodayAllowance(userId);
    const remainingToday =
      Number(allowance.amountAllocated) +
      Number(allowance.surplusCarriedIn) -
      Number(allowance.amountSpent);

    const weekRows = await this.prisma.dailyAllowance.findMany({
      where: { userId, weekStartDate: allowance.weekStartDate },
    });
    const remainingWeek = weekRows.reduce(
      (sum, row) =>
        sum +
        Number(row.amountAllocated) +
        Number(row.surplusCarriedIn) -
        Number(row.amountSpent),
      0,
    );

    return { allowance, remainingToday, remainingWeek };
  }

  /**
   * Determines whether a requested spend is NORMAL / EARLY_ACCESS / BORROWED,
   * and what it would cost. Does not move money — callers execute via Rubies
   * only after the user confirms (pre-transfer confirmation, PRD section 4a/5).
   */
  async evaluateSpend(userId: string, amount: number, now: Date = new Date()) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const allowance = await this.getOrCreateTodayAllowance(userId);

    const remainingToday =
      Number(allowance.amountAllocated) +
      Number(allowance.surplusCarriedIn) -
      Number(allowance.amountSpent);

    // Deliberate exit (PRD §4.1): once the Manager has approved an
    // EXIT_RESTRICTIONS request, disciplineExitedAt is set (see
    // ManagerConversationService) and the account "returns to normal" —
    // no window check, no override fees, ever, regardless of amount/time.
    if (user.disciplineExitedAt) {
      return {
        type: TransactionType.NORMAL,
        remainingToday,
        withinWindow: true,
        feeAmount: 0,
        waived: false,
        totalCost: amount,
      };
    }

    const withinWindow = this.windowService.isWithinWindow(
      user.windowStartHour,
      user.windowEndHour,
      now,
    );

    let type: TransactionType;
    if (!withinWindow) {
      type = TransactionType.EARLY_ACCESS;
    } else if (amount > remainingToday) {
      type = TransactionType.BORROWED;
    } else {
      type = TransactionType.NORMAL;
    }

    const fee = this.feeCalculator.calculate(
      type,
      amount,
      Number(allowance.surplusCarriedIn),
    );

    return {
      type,
      remainingToday,
      withinWindow,
      feeAmount: fee.feeAmount,
      waived: fee.waived,
      totalCost: amount + fee.feeAmount,
    };
  }

  /**
   * Applies an EXECUTED transaction's amount against the allowance for the day
   * it happened. Idempotent and Transaction-scoped: a transaction whose
   * appliedToAllowanceAt is already set is a no-op rather than double-counting
   * the spend — safe to call twice (e.g. from a retried Rubies webhook and the
   * TSQ reconciliation job landing on the same transaction).
   */
  async recordSpend(transactionId: string) {
    const transaction = await this.prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    });

    if (transaction.appliedToAllowanceAt) {
      if (!transaction.dailyAllowanceId) {
        throw new Error(
          `Transaction ${transactionId} has appliedToAllowanceAt set but no dailyAllowanceId — data is inconsistent`,
        );
      }
      return this.prisma.dailyAllowance.findUniqueOrThrow({
        where: { id: transaction.dailyAllowanceId },
      });
    }

    if (transaction.status !== TransactionStatus.EXECUTED) {
      throw new BadRequestException(
        `Cannot record spend for transaction ${transactionId}: status is ${transaction.status}, not EXECUTED`,
      );
    }

    // Attribute the spend to the day the transaction was created, not "now" —
    // the caller (a Rubies webhook or the TSQ reconciliation job) may run well
    // after midnight relative to when the user actually confirmed the spend.
    const spendDay = watDateBucketKey(transaction.createdAt);
    const allowance = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId: transaction.userId, date: spendDay } },
    });
    if (!allowance) {
      throw new NotFoundException(
        `No allowance row for ${spendDay.toDateString()} (transaction ${transactionId})`,
      );
    }

    const [, updatedAllowance] = await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: transactionId },
        data: {
          appliedToAllowanceAt: new Date(),
          dailyAllowanceId: allowance.id,
        },
      }),
      this.prisma.dailyAllowance.update({
        where: { id: allowance.id },
        data: {
          amountSpent:
            Number(allowance.amountSpent) + Number(transaction.amount),
        },
      }),
    ]);

    return updatedAllowance;
  }
}
