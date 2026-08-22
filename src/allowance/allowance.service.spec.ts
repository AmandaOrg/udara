import { BadRequestException } from "@nestjs/common";
import { AllowanceService } from "./allowance.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { TransactionType } from "../common/enums/transaction-type.enum";
import { TransactionStatus } from "@prisma/client";

/**
 * Uses real WindowService/FeeCalculatorService (both pure/deterministic) and a
 * hand-mocked PrismaService, so the classification logic (NORMAL/EARLY_ACCESS/
 * BORROWED) is exercised against real fee math rather than stubbed-out numbers.
 */
describe("AllowanceService", () => {
  let service: AllowanceService;
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    dailyAllowance: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    transaction: {
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const userId = "user-1";
  // Explicit UTC instants (never the local Date constructor) with the WAT
  // wall-clock equivalent noted — this is what actually exercises
  // WindowService's WAT-anchoring (see wat-time.util.ts) and keeps the suite
  // deterministic regardless of the machine/CI's own timezone. A
  // local-constructor fixture would coincidentally pass here even with the
  // shipped production bug reintroduced, on a WAT-timezone dev machine.
  const today = new Date("2026-01-08T00:00:00Z"); // a Thursday, a @db.Date-style bucket key
  const withinWindowNow = new Date("2026-01-08T14:00:00Z"); // 3 PM WAT, inside 11-20
  const outsideWindowNow = new Date("2026-01-08T20:00:00Z"); // 9 PM WAT, outside 11-20

  function makeUser(
    overrides: Partial<{
      windowStartHour: number;
      windowEndHour: number;
      disciplineExitedAt: Date | null;
      monthlyIncome: number | null;
    }> = {},
  ) {
    return {
      id: userId,
      windowStartHour: 11,
      windowEndHour: 20,
      disciplineExitedAt: null,
      monthlyIncome: null,
      ...overrides,
    };
  }

  function makeAllowance(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "allowance-1",
      userId,
      date: today,
      weekStartDate: today,
      amountAllocated: 10_000,
      surplusCarriedIn: 0,
      amountSpent: 0,
      ...overrides,
    };
  }

  function makeTransaction(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "txn-1",
      userId,
      amount: 500,
      status: TransactionStatus.EXECUTED,
      createdAt: today,
      appliedToAllowanceAt: null,
      dailyAllowanceId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(makeUser()) },
      dailyAllowance: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      transaction: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    service = new AllowanceService(
      prisma as any,
      new WindowService(),
      new FeeCalculatorService(),
    );
  });

  describe("evaluateSpend", () => {
    it("classifies as NORMAL when inside the window and within remaining allowance", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValue(
        makeAllowance({ amountSpent: 2_000 }),
      );

      const result = await service.evaluateSpend(
        userId,
        3_000,
        withinWindowNow,
      );

      expect(result.type).toBe(TransactionType.NORMAL);
      expect(result.withinWindow).toBe(true);
      expect(result.feeAmount).toBe(0);
      expect(result.remainingToday).toBe(8_000);
      expect(result.totalCost).toBe(3_000);
    });

    it("classifies as EARLY_ACCESS when outside the window, even with plenty of allowance left", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValue(makeAllowance());

      const result = await service.evaluateSpend(
        userId,
        1_000,
        outsideWindowNow,
      );

      expect(result.type).toBe(TransactionType.EARLY_ACCESS);
      expect(result.withinWindow).toBe(false);
      expect(result.feeAmount).toBeCloseTo(1000 + 1_000 * 0.002);
      expect(result.waived).toBe(false);
    });

    it("classifies as BORROWED when inside the window but amount exceeds remaining allowance", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValue(
        makeAllowance({ amountSpent: 9_000 }),
      );

      const result = await service.evaluateSpend(
        userId,
        5_000,
        withinWindowNow,
      );

      expect(result.type).toBe(TransactionType.BORROWED);
      expect(result.remainingToday).toBe(1_000);
      expect(result.feeAmount).toBeCloseTo(1000 + 5_000 * 0.004);
      expect(result.waived).toBe(false);
    });

    it("waives the BORROWED fee when prior-day surplus covers the overage", async () => {
      // remainingToday = 10_000 (allocated) + 6_000 (surplus) - 15_000 (already spent) = 1_000,
      // so the new 5_000 spend exceeds it (BORROWED) — and 5_000 <= the 6_000 surplus, so waived.
      prisma.dailyAllowance.findUnique.mockResolvedValue(
        makeAllowance({ amountSpent: 15_000, surplusCarriedIn: 6_000 }),
      );

      const result = await service.evaluateSpend(
        userId,
        5_000,
        withinWindowNow,
      );

      expect(result.type).toBe(TransactionType.BORROWED);
      expect(result.waived).toBe(true);
      expect(result.feeAmount).toBe(0);
    });

    it("prioritizes EARLY_ACCESS over BORROWED when both conditions hold", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValue(
        makeAllowance({ amountSpent: 9_500 }),
      );

      const result = await service.evaluateSpend(
        userId,
        5_000,
        outsideWindowNow,
      );

      expect(result.type).toBe(TransactionType.EARLY_ACCESS);
    });

    it("uses the user-specific window hours, not just the default", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ windowStartHour: 6, windowEndHour: 9 }),
      );
      prisma.dailyAllowance.findUnique.mockResolvedValue(makeAllowance());
      const sevenAm = new Date("2026-01-08T06:00:00Z"); // 7 AM WAT

      const result = await service.evaluateSpend(userId, 1_000, sevenAm);

      expect(result.withinWindow).toBe(true);
      expect(result.type).toBe(TransactionType.NORMAL);
    });

    it("bypasses window/fee enforcement entirely once disciplineExitedAt is set", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ disciplineExitedAt: new Date(2026, 0, 1) }),
      );
      // Deliberately outside the window and over the remaining allowance — would
      // otherwise be EARLY_ACCESS or BORROWED with a fee attached.
      prisma.dailyAllowance.findUnique.mockResolvedValue(
        makeAllowance({ amountSpent: 9_999 }),
      );

      const result = await service.evaluateSpend(
        userId,
        50_000,
        outsideWindowNow,
      );

      expect(result.type).toBe(TransactionType.NORMAL);
      expect(result.withinWindow).toBe(true);
      expect(result.feeAmount).toBe(0);
      expect(result.waived).toBe(false);
      expect(result.totalCost).toBe(50_000);
    });
  });

  describe("getOrCreateTodayAllowance", () => {
    it("returns the existing row without creating a new one if today already has one", async () => {
      const existing = makeAllowance();
      prisma.dailyAllowance.findUnique.mockResolvedValue(existing);

      const result = await service.getOrCreateTodayAllowance(userId);

      expect(result).toBe(existing);
      expect(prisma.dailyAllowance.create).not.toHaveBeenCalled();
    });

    it("creates a fresh row with zero surplus when there is no prior-day allowance", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null); // today
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null); // yesterday
      prisma.dailyAllowance.create.mockResolvedValue(makeAllowance());

      await service.getOrCreateTodayAllowance(userId);

      expect(prisma.dailyAllowance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ surplusCarriedIn: 0 }),
        }),
      );
    });

    it("never carries a negative surplus forward", async () => {
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null); // today
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(
        // yesterday: overspent relative to allocation+surplus
        makeAllowance({
          date: new Date("2026-01-07T00:00:00Z"),
          weekStartDate: today,
          amountAllocated: 1_000,
          surplusCarriedIn: 0,
          amountSpent: 5_000,
        }),
      );
      prisma.dailyAllowance.create.mockResolvedValue(makeAllowance());

      await service.getOrCreateTodayAllowance(userId);

      expect(prisma.dailyAllowance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ surplusCarriedIn: 0 }),
        }),
      );
    });

    it("computes the daily amount as a fixed 30% of monthlyIncome spread over 30 days, no income-tier branching", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ monthlyIncome: 900_000 }),
      );
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null); // today
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null); // yesterday
      prisma.dailyAllowance.create.mockResolvedValue(makeAllowance());

      await service.getOrCreateTodayAllowance(userId);

      // (900_000 * 0.3) / 30 = 9_000 — a fixed /30 divisor, never the actual
      // days in the current calendar month, so this figure always matches
      // the plan shown at onboarding (dailyLimit * 30 === monthlyAllowance).
      expect(prisma.dailyAllowance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountAllocated: 9_000 }),
        }),
      );
    });

    it("returns 0 when no plan has been set yet (monthlyIncome unset)", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ monthlyIncome: null }),
      );
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null);
      prisma.dailyAllowance.findUnique.mockResolvedValueOnce(null);
      prisma.dailyAllowance.create.mockResolvedValue(makeAllowance());

      await service.getOrCreateTodayAllowance(userId);

      expect(prisma.dailyAllowance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amountAllocated: 0 }),
        }),
      );
    });
  });

  describe("recordSpend", () => {
    it("applies the transaction's amount to that day's allowance and marks it applied", async () => {
      const transaction = makeTransaction({ amount: 500 });
      const allowance = makeAllowance({ amountSpent: 1_000 });
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(transaction);
      prisma.dailyAllowance.findUnique.mockResolvedValue(allowance);
      prisma.transaction.update.mockResolvedValue({
        ...transaction,
        appliedToAllowanceAt: new Date(),
      });
      prisma.dailyAllowance.update.mockResolvedValue({
        ...allowance,
        amountSpent: 1_500,
      });

      const result = await service.recordSpend("txn-1");

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "txn-1" },
          data: expect.objectContaining({ dailyAllowanceId: allowance.id }),
        }),
      );
      expect(prisma.dailyAllowance.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { amountSpent: 1_500 } }),
      );
      expect(result.amountSpent).toBe(1_500);
    });

    it("is idempotent — a second call on an already-applied transaction is a no-op", async () => {
      const allowance = makeAllowance({ amountSpent: 1_500 });
      const appliedTransaction = makeTransaction({
        appliedToAllowanceAt: new Date(),
        dailyAllowanceId: allowance.id,
      });
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        appliedTransaction,
      );
      prisma.dailyAllowance.findUniqueOrThrow.mockResolvedValue(allowance);

      const result = await service.recordSpend("txn-1");

      expect(result).toBe(allowance);
      expect(prisma.dailyAllowance.update).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });

    it("refuses to apply a transaction that is not EXECUTED", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.PENDING_CONFIRMATION }),
      );

      await expect(service.recordSpend("txn-1")).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.dailyAllowance.update).not.toHaveBeenCalled();
    });

    it("throws if there is no allowance row for the transaction's day", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(makeTransaction());
      prisma.dailyAllowance.findUnique.mockResolvedValue(null);

      await expect(service.recordSpend("txn-1")).rejects.toThrow();
    });
  });
});
