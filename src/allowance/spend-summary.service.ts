import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RecipientLabel, TransactionStatus } from "@prisma/client";

export interface WeeklySpendSummary {
  weekStartDate: Date;
  totalSpent: number;
  byDay: { date: string; amount: number }[];
  byLabel: Partial<Record<RecipientLabel, number>>;
  transactionCount: number;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Deliberately NOT startOfDay(d).toISOString().slice(0, 10) — that round-trips a
// local-midnight Date through UTC serialization and is off by one day in any
// positive-UTC-offset timezone (see the flagged AllowanceService/WindowService
// timezone bug). This formats the local calendar date directly instead.
function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfIsoWeek(d: Date): Date {
  const date = startOfDay(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  return date;
}

/**
 * PRD §8 success criterion: "spending can be reconstructed for a given week
 * without manually digging through bank apps." Deliberately deterministic —
 * a plain Prisma aggregation, no AI-generated analysis (that's PRD §3 #11,
 * out of scope for this plan) — just the numbers.
 */
@Injectable()
export class SpendSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getWeeklySummary(
    userId: string,
    now: Date = new Date(),
  ): Promise<WeeklySpendSummary> {
    const weekStartDate = startOfIsoWeek(now);

    const transactions = await this.prisma.transaction.findMany({
      where: {
        userId,
        status: TransactionStatus.EXECUTED,
        createdAt: { gte: weekStartDate },
      },
      include: { recipient: true },
    });

    const byDayMap = new Map<string, number>();
    const byLabel: Partial<Record<RecipientLabel, number>> = {};
    let totalSpent = 0;

    for (const txn of transactions) {
      const amount = Number(txn.amount);
      totalSpent += amount;

      const dayKey = formatLocalDate(txn.createdAt);
      byDayMap.set(dayKey, (byDayMap.get(dayKey) ?? 0) + amount);

      const label = txn.recipient.label;
      byLabel[label] = (byLabel[label] ?? 0) + amount;
    }

    const byDay = Array.from(byDayMap.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      weekStartDate,
      totalSpent,
      byDay,
      byLabel,
      transactionCount: transactions.length,
    };
  }

  /** Formats a WeeklySpendSummary as WhatsApp-ready plain text. */
  formatAsText(summary: WeeklySpendSummary): string {
    if (summary.transactionCount === 0) {
      return "No spending recorded yet this week.";
    }

    const lines = [
      `This week you've spent ₦${summary.totalSpent.toLocaleString("en-NG")} across ${summary.transactionCount} transaction${summary.transactionCount === 1 ? "" : "s"}.`,
    ];

    if (summary.byDay.length > 0) {
      const dayLines = summary.byDay.map(
        (d) => `  ${d.date}: ₦${d.amount.toLocaleString("en-NG")}`,
      );
      lines.push("By day:", ...dayLines);
    }

    const labelEntries = Object.entries(summary.byLabel) as [
      RecipientLabel,
      number,
    ][];
    if (labelEntries.length > 0) {
      const labelLines = labelEntries.map(
        ([label, amount]) => `  ${label}: ₦${amount.toLocaleString("en-NG")}`,
      );
      lines.push("By category:", ...labelLines);
    }

    return lines.join("\n");
  }
}
