import { FeeCalculatorService } from "./fee-calculator.service";
import { TransactionType } from "../common/enums/transaction-type.enum";

/**
 * Locks down the exact fee figures from the PRD/.env.example: early access
 * ₦1,000 + 0.2%, borrowing ₦1,000 + 0.4%, waived if prior-day surplus covers it.
 * This is the one mechanic the whole product depends on (README's stated priority).
 */
describe("FeeCalculatorService", () => {
  let service: FeeCalculatorService;

  beforeEach(() => {
    service = new FeeCalculatorService();
  });

  describe("NORMAL spend", () => {
    it("charges no fee regardless of amount", () => {
      const result = service.calculate(TransactionType.NORMAL, 50_000, 0);
      expect(result).toEqual({ feeAmount: 0, waived: false });
    });
  });

  describe("EARLY_ACCESS spend", () => {
    it("charges flat ₦1,000 + 0.2% of the amount", () => {
      const result = service.calculate(TransactionType.EARLY_ACCESS, 10_000, 0);
      expect(result.waived).toBe(false);
      expect(result.feeAmount).toBeCloseTo(1000 + 10_000 * 0.002); // 1020
    });

    it("is never waived by surplus, unlike BORROWED", () => {
      const result = service.calculate(
        TransactionType.EARLY_ACCESS,
        5_000,
        100_000,
      );
      expect(result.waived).toBe(false);
      expect(result.feeAmount).toBeCloseTo(1000 + 5_000 * 0.002);
    });

    it("scales the percentage component with amount", () => {
      const small = service.calculate(TransactionType.EARLY_ACCESS, 1_000, 0);
      const large = service.calculate(TransactionType.EARLY_ACCESS, 100_000, 0);
      expect(large.feeAmount).toBeGreaterThan(small.feeAmount);
      expect(small.feeAmount).toBeCloseTo(1000 + 1_000 * 0.002);
      expect(large.feeAmount).toBeCloseTo(1000 + 100_000 * 0.002);
    });
  });

  describe("BORROWED spend", () => {
    it("charges flat ₦1,000 + 0.4% when surplus does not cover it", () => {
      const result = service.calculate(TransactionType.BORROWED, 10_000, 0);
      expect(result.waived).toBe(false);
      expect(result.feeAmount).toBeCloseTo(1000 + 10_000 * 0.004); // 1040
    });

    it("is fully waived when prior-day surplus covers the whole amount", () => {
      const result = service.calculate(TransactionType.BORROWED, 5_000, 5_000);
      expect(result).toEqual({ feeAmount: 0, waived: true });
    });

    it("is fully waived when surplus exceeds the amount", () => {
      const result = service.calculate(TransactionType.BORROWED, 5_000, 20_000);
      expect(result).toEqual({ feeAmount: 0, waived: true });
    });

    it("charges the full fee when surplus is less than the amount (no partial waiver)", () => {
      const result = service.calculate(TransactionType.BORROWED, 10_000, 4_999);
      expect(result.waived).toBe(false);
      expect(result.feeAmount).toBeCloseTo(1000 + 10_000 * 0.004);
    });

    it("treats surplus exactly equal to amount as fully covering it", () => {
      const result = service.calculate(TransactionType.BORROWED, 7_500, 7_500);
      expect(result.waived).toBe(true);
      expect(result.feeAmount).toBe(0);
    });
  });

  describe("env overrides", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("reads fee constants from env vars when set", () => {
      process.env.EARLY_ACCESS_FLAT_FEE = "500";
      process.env.EARLY_ACCESS_PERCENT_FEE = "0.01";
      const custom = new FeeCalculatorService();
      const result = custom.calculate(TransactionType.EARLY_ACCESS, 1_000, 0);
      expect(result.feeAmount).toBeCloseTo(500 + 1_000 * 0.01);
    });
  });
});
