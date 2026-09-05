import { ExtractionValidatorService } from "./extraction-validator.service";

describe("ExtractionValidatorService", () => {
  const validator = new ExtractionValidatorService();

  describe("validateQuickQuestions", () => {
    it("accepts a well-formed record with all four fields", () => {
      const result = validator.validateQuickQuestions({
        name: "Daniel",
        city: "Lagos",
        monthlyIncome: 500_000,
        spendingRegret: "food delivery",
      });
      expect(result).toEqual({
        accepted: true,
        cleanedValue: {
          name: "Daniel",
          city: "Lagos",
          monthlyIncome: 500_000,
          spendingRegret: "food delivery",
        },
      });
    });

    it("trims whitespace", () => {
      const result = validator.validateQuickQuestions({
        name: "  Daniel  ",
        city: "  Lagos  ",
        monthlyIncome: 500_000,
        spendingRegret: "  food delivery  ",
      });
      expect(result.cleanedValue).toEqual({
        name: "Daniel",
        city: "Lagos",
        monthlyIncome: 500_000,
        spendingRegret: "food delivery",
      });
    });

    it.each([
      [{ city: "Lagos", monthlyIncome: 500_000, spendingRegret: "x" }], // missing name
      [{ name: "Daniel", monthlyIncome: 500_000, spendingRegret: "x" }], // missing city
      [{ name: "Daniel", city: "Lagos", spendingRegret: "x" }], // missing income
      [{ name: "Daniel", city: "Lagos", monthlyIncome: 500_000 }], // missing regret
      [
        {
          name: "",
          city: "Lagos",
          monthlyIncome: 500_000,
          spendingRegret: "x",
        },
      ],
      [
        {
          name: "Daniel",
          city: "Lagos",
          monthlyIncome: 0,
          spendingRegret: "x",
        },
      ],
      [
        {
          name: "Daniel",
          city: "Lagos",
          monthlyIncome: 999_999_999,
          spendingRegret: "x",
        },
      ],
      [
        {
          name: "Daniel",
          city: "Lagos",
          monthlyIncome: "not a number",
          spendingRegret: "x",
        },
      ],
      [null],
      ["not an object"],
    ])("rejects malformed input: %p", (args) => {
      expect(validator.validateQuickQuestions(args).accepted).toBe(false);
    });

    it("rejects an implausibly long name", () => {
      const result = validator.validateQuickQuestions({
        name: "a".repeat(101),
        city: "Lagos",
        monthlyIncome: 500_000,
        spendingRegret: "food delivery",
      });
      expect(result.accepted).toBe(false);
    });
  });

  describe("validateMoneyStory", () => {
    it("accepts a well-formed record with all three fields", () => {
      const result = validator.validateMoneyStory({
        statedGoal: "save for a car",
        difficulty: "impulse spending on weekends",
        priorAttempts: "tried a budgeting app, didn't stick",
      });
      expect(result).toEqual({
        accepted: true,
        cleanedValue: {
          statedGoal: "save for a car",
          difficulty: "impulse spending on weekends",
          priorAttempts: "tried a budgeting app, didn't stick",
        },
      });
    });

    it.each([
      [{ difficulty: "x", priorAttempts: "y" }], // missing statedGoal
      [{ statedGoal: "x", priorAttempts: "y" }], // missing difficulty
      [{ statedGoal: "x", difficulty: "y" }], // missing priorAttempts
      [{ statedGoal: "", difficulty: "y", priorAttempts: "z" }],
      [null],
      ["not an object"],
    ])("rejects: %p", (args) => {
      expect(validator.validateMoneyStory(args).accepted).toBe(false);
    });
  });

});
