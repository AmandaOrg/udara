import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RecipientLabel, TransactionStatus } from "@prisma/client";
import {
  getWatDateParts,
  startOfWatIsoWeekInstant,
} from "../common/wat-time.util";

export interface WeeklySpendSummary {
  weekStartDate: Date;
  totalSpent: number;
  byDay: { date: string; amount: number }[];
  byLabel: Partial<Record<RecipientLabel, number>>;
  transactionCount: number;
}

// The WAT calendar date a transaction falls on, as a "YYYY-MM-DD" grouping
// key. WAT-anchored (not the process's local timezone, not a UTC round-trip
// of a local Date) — the root fix for what used to be worked around here as
// "the flagged AllowanceService/WindowService timezone bug"; see
// wat-time.util.ts for why that ambient-timezone dependency was wrong.
function formatWatDate(d: Date): string {
  const { year, month, day } = getWatDateParts(d);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
    const weekStartDate = startOfWatIsoWeekInstant(now);

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

      const dayKey = formatWatDate(txn.createdAt);
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
