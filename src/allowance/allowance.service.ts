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

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfIsoWeek(d: Date): Date {
  const date = startOfDay(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  date.setDate(date.getDate() + diff);
  return date;
}

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
  private computeDailyAmount(user: Pick<User, "monthlyIncome">): number {
    if (!user.monthlyIncome) return 0;
    const WANTS_ALLOCATION_PCT = 0.3;
    return (Number(user.monthlyIncome) * WANTS_ALLOCATION_PCT) / 30;
  }

  /** Fetch or lazily create today's allowance row for a user. */
  async getOrCreateTodayAllowance(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const today = startOfDay(new Date());

    const existing = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: today } },
    });
    if (existing) return existing;

    const dailyAmount = this.computeDailyAmount(user);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayAllowance = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: yesterday } },
    });

    const sameWeek =
      yesterdayAllowance &&
      startOfIsoWeek(yesterdayAllowance.date).getTime() ===
        startOfIsoWeek(today).getTime();

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
        weekStartDate: startOfIsoWeek(today),
        amountAllocated: dailyAmount,
        surplusCarriedIn: Math.max(surplus, 0),
      },
    });
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
    const spendDay = startOfDay(transaction.createdAt);
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
