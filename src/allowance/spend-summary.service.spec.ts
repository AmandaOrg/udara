import { SpendSummaryService } from "./spend-summary.service";
import { RecipientLabel, TransactionStatus } from "@prisma/client";

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
      createdAt: new Date(2026, 0, 8, 12, 0),
      recipient: { label: RecipientLabel.OTHER },
      ...overrides,
    };
  }

  describe("getWeeklySummary", () => {
    it("only queries EXECUTED transactions from this ISO week onward", async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.getWeeklySummary("user-1", new Date(2026, 0, 8)); // Thursday

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            status: TransactionStatus.EXECUTED,
            createdAt: { gte: new Date(2026, 0, 5) }, // Monday of that week
          }),
        }),
      );
    });

    it("sums total spend, groups by day, and groups by recipient label", async () => {
      prisma.transaction.findMany.mockResolvedValue([
        txn({
          amount: 1000,
          createdAt: new Date(2026, 0, 5, 10, 0),
          recipient: { label: RecipientLabel.RENT },
        }),
        txn({
          amount: 500,
          createdAt: new Date(2026, 0, 5, 15, 0),
          recipient: { label: RecipientLabel.FOOD },
        }),
        txn({
          amount: 2000,
          createdAt: new Date(2026, 0, 6, 9, 0),
          recipient: { label: RecipientLabel.RENT },
        }),
      ]);

      const summary = await service.getWeeklySummary(
        "user-1",
        new Date(2026, 0, 8),
      );

      expect(summary.totalSpent).toBe(3500);
      expect(summary.transactionCount).toBe(3);
      expect(summary.byDay).toEqual([
        { date: "2026-01-05", amount: 1500 },
        { date: "2026-01-06", amount: 2000 },
      ]);
      expect(summary.byLabel).toEqual({ RENT: 3000, FOOD: 500 });
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
