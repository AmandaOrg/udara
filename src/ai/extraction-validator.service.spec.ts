import { ExtractionValidatorService } from "./extraction-validator.service";

describe("ExtractionValidatorService", () => {
  const validator = new ExtractionValidatorService();

  describe("validateIdentity", () => {
    it("accepts a well-formed name and occupation", () => {
      const result = validator.validateIdentity({
        name: "Daniel",
        occupation: "software engineer",
      });
      expect(result).toEqual({
        accepted: true,
        cleanedValue: { name: "Daniel", occupation: "software engineer" },
      });
    });

    it("trims whitespace", () => {
      const result = validator.validateIdentity({
        name: "  Daniel  ",
        occupation: "  engineer  ",
      });
      expect(result.cleanedValue).toEqual({
        name: "Daniel",
        occupation: "engineer",
      });
    });

    it.each([
      [{ name: "", occupation: "engineer" }],
      [{ name: "Daniel", occupation: "" }],
      [{ name: "   ", occupation: "engineer" }],
      [{ occupation: "engineer" }],
      [{ name: 123, occupation: "engineer" }],
      [null],
      ["not an object"],
    ])("rejects malformed input: %p", (args) => {
      expect(validator.validateIdentity(args).accepted).toBe(false);
    });

    it("rejects an implausibly long name", () => {
      const result = validator.validateIdentity({
        name: "a".repeat(101),
        occupation: "engineer",
      });
      expect(result.accepted).toBe(false);
    });
  });

  describe("validateMoneyStory", () => {
    it("accepts a well-formed record with all fields", () => {
      const result = validator.validateMoneyStory({
        monthlyIncome: 1_500_000,
        statedGoal: "save for a car",
        spendingRegret: "food delivery",
        spendingTrigger: "stress",
      });
      expect(result.accepted).toBe(true);
      expect(result.cleanedValue?.monthlyIncome).toBe(1_500_000);
      expect(result.cleanedValue?.statedGoal).toBe("save for a car");
      expect(result.cleanedValue?.spendingRegret).toBe("food delivery");
    });

    it("accepts with only the two required fields", () => {
      const result = validator.validateMoneyStory({
        monthlyIncome: 200_000,
        statedGoal: "save for rent",
      });
      expect(result.accepted).toBe(true);
      expect(result.cleanedValue?.spendingRegret).toBeUndefined();
    });

    it.each([
      [{ monthlyIncome: 0, statedGoal: "x" }], // zero
      [{ monthlyIncome: -500, statedGoal: "x" }], // negative
      [{ monthlyIncome: 999_999_999, statedGoal: "x" }], // absurdly high
      [{ monthlyIncome: "not a number", statedGoal: "x" }],
      [{ monthlyIncome: 100_000, statedGoal: "" }], // missing goal
      [{ statedGoal: "x" }], // missing income
    ])("rejects: %p", (args) => {
      expect(validator.validateMoneyStory(args).accepted).toBe(false);
    });
  });

  describe("validateReflectionContext", () => {
    it("accepts city alone (age optional)", () => {
      const result = validator.validateReflectionContext({ city: "Abuja" });
      expect(result).toEqual({
        accepted: true,
        cleanedValue: { city: "Abuja", age: undefined },
      });
    });

    it("accepts city with a plausible age", () => {
      const result = validator.validateReflectionContext({
        city: "Lagos",
        age: 26,
      });
      expect(result.cleanedValue).toEqual({ city: "Lagos", age: 26 });
    });

    it("rejects a missing city", () => {
      expect(validator.validateReflectionContext({ age: 26 }).accepted).toBe(
        false,
      );
    });

    it.each([[5], [150], ["not a number"]])(
      "rejects an implausible age: %p",
      (age) => {
        expect(
          validator.validateReflectionContext({ city: "Lagos", age }).accepted,
        ).toBe(false);
      },
    );
  });
});
