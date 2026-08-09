import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { TransactionType } from "../common/enums/transaction-type.enum";

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

  /** Fetch or lazily create today's allowance row for a user. */
  async getOrCreateTodayAllowance(userId: string) {
    // TODO (Phase 5): use `user` to compute the real plan-derived daily figure
    // (FLAT -> user.flatDailyAmount, PERCENTAGE -> monthlyIncome * budgetPercentage)
    // instead of the dailyAmount=0 placeholder below.
    const _user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const today = startOfDay(new Date());

    const existing = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: today } },
    });
    if (existing) return existing;

    // TODO: replace with the real plan-derived daily figure —
    // flat (monthlyIncome-based) or percentage, per section 7a.
    const dailyAmount = 0;

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

    const withinWindow = this.windowService.isWithinWindow(
      user.windowStartHour,
      user.windowEndHour,
      now,
    );

    const remainingToday =
      Number(allowance.amountAllocated) +
      Number(allowance.surplusCarriedIn) -
      Number(allowance.amountSpent);

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

  /** Records a confirmed spend against today's allowance once executed. */
  async recordSpend(userId: string, amount: number) {
    const today = startOfDay(new Date());
    const allowance = await this.prisma.dailyAllowance.findUnique({
      where: { userId_date: { userId, date: today } },
    });
    if (!allowance) throw new NotFoundException("No allowance row for today");

    return this.prisma.dailyAllowance.update({
      where: { id: allowance.id },
      data: { amountSpent: Number(allowance.amountSpent) + amount },
    });
  }
}
