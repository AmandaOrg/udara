import { SpendSummaryService } from "./spend-summary.service";
import { RecipientLabel, TransactionStatus } from "@prisma/client";

/**
 * Fixtures are explicit UTC instants (never the local Date constructor),
 * with the WAT wall-clock equivalent noted in a comment — this is what
 * actually exercises the WAT-anchored day/week bucketing (see
 * wat-time.util.ts) and keeps the suite deterministic regardless of the
 * machine/CI's own timezone.
 */
describe("SpendSummaryService", () => {
  let prisma: { transaction: { findMany: jest.Mock } };
  let service: SpendSummaryService;

  beforeEach(() => {
    prisma = { transaction: { findMany: jest.fn() } };
    service = new SpendSummaryService(prisma as any);
  });

  function txn(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      amount: 1000,
      createdAt: new Date("2026-01-08T11:00:00Z"), // noon WAT
      recipient: { label: RecipientLabel.OTHER },
      ...overrides,
    };
  }

  describe("getWeeklySummary", () => {
    it("only queries EXECUTED transactions from this ISO week onward", async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      // Thursday, 11 AM WAT
      await service.getWeeklySummary(
        "user-1",
        new Date("2026-01-08T10:00:00Z"),
      );

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            status: TransactionStatus.EXECUTED,
            // The true instant of Monday 00:00 WAT (see startOfWatIsoWeekInstant).
            createdAt: { gte: new Date("2026-01-04T23:00:00Z") },
          }),
        }),
      );
    });

    it("sums total spend, groups by day, and groups by recipient label", async () => {
      prisma.transaction.findMany.mockResolvedValue([
        txn({
          amount: 1000,
          createdAt: new Date("2026-01-05T09:00:00Z"), // 10 AM WAT, Mon Jan 5
          recipient: { label: RecipientLabel.RENT },
        }),
        txn({
          amount: 500,
          createdAt: new Date("2026-01-05T14:00:00Z"), // 3 PM WAT, Mon Jan 5
          recipient: { label: RecipientLabel.FOOD },
        }),
        txn({
          amount: 2000,
          createdAt: new Date("2026-01-06T08:00:00Z"), // 9 AM WAT, Tue Jan 6
          recipient: { label: RecipientLabel.RENT },
        }),
      ]);

      const summary = await service.getWeeklySummary(
        "user-1",
        new Date("2026-01-08T10:00:00Z"),
      );

      expect(summary.totalSpent).toBe(3500);
      expect(summary.transactionCount).toBe(3);
      expect(summary.byDay).toEqual([
        { date: "2026-01-05", amount: 1500 },
        { date: "2026-01-06", amount: 2000 },
      ]);
      expect(summary.byLabel).toEqual({ RENT: 3000, FOOD: 500 });
    });

    it("groups a late-UTC transaction under the WAT calendar day it actually happened on", async () => {
      // 23:30 UTC on Jan 5 is already 00:30 WAT on Jan 6 — must be grouped
      // under "2026-01-06", not the UTC calendar date. This is exactly the
      // class of bug that shipped: reading a Date's UTC/local components
      // directly instead of going through the WAT-anchored formatter.
      prisma.transaction.findMany.mockResolvedValue([
        txn({ createdAt: new Date("2026-01-05T23:30:00Z"), amount: 750 }),
      ]);

      const summary = await service.getWeeklySummary(
        "user-1",
        new Date("2026-01-08T10:00:00Z"),
      );

      expect(summary.byDay).toEqual([{ date: "2026-01-06", amount: 750 }]);
    });

    it("returns zeroed-out data when there is no spending", async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      const summary = await service.getWeeklySummary("user-1");
      expect(summary.totalSpent).toBe(0);
      expect(summary.transactionCount).toBe(0);
      expect(summary.byDay).toEqual([]);
      expect(summary.byLabel).toEqual({});
    });
  });

  describe("formatAsText", () => {
    it("says so plainly when there's nothing to report", () => {
      const text = service.formatAsText({
        weekStartDate: new Date(),
        totalSpent: 0,
        byDay: [],
        byLabel: {},
        transactionCount: 0,
      });
      expect(text).toBe("No spending recorded yet this week.");
    });

    it("includes total, per-day, and per-category breakdowns", () => {
      const text = service.formatAsText({
        weekStartDate: new Date(),
        totalSpent: 3500,
        byDay: [{ date: "2026-01-05", amount: 3500 }],
        byLabel: { RENT: 3000, FOOD: 500 },
        transactionCount: 3,
      });
      expect(text).toContain("₦3,500");
      expect(text).toContain("2026-01-05");
      expect(text).toContain("RENT: ₦3,000");
      expect(text).toContain("FOOD: ₦500");
    });
  });
});
