import {
  STRUCTURED_QUESTIONS,
  STRICTNESS_LEVEL_BY_SQ2_ID,
} from "./structured-questions.data";

describe("STRUCTURED_QUESTIONS", () => {
  it("has 2 questions, matching the Udara onboarding script's merged Stage 7", () => {
    expect(STRUCTURED_QUESTIONS).toHaveLength(2);
  });

  it("keeps every row within WhatsApp's list-message limits (<=10 rows, title<=24, description<=72)", () => {
    for (const question of STRUCTURED_QUESTIONS) {
      expect(question.rows.length).toBeLessThanOrEqual(10);
      expect(question.buttonLabel.length).toBeLessThanOrEqual(20);
      for (const row of question.rows) {
        expect(row.title.length).toBeLessThanOrEqual(24);
        if (row.description)
          expect(row.description.length).toBeLessThanOrEqual(72);
      }
    }
  });

  it("has globally unique row ids across all questions", () => {
    const ids = STRUCTURED_QUESTIONS.flatMap((q) => q.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every sq2 row id has a strictness level mapping between 1 and 4", () => {
    const sq2 = STRUCTURED_QUESTIONS.find((q) => q.key === "sq2");
    expect(sq2?.rows.length).toBeGreaterThan(0);
    for (const row of sq2?.rows ?? []) {
      expect(STRICTNESS_LEVEL_BY_SQ2_ID[row.id]).toBeGreaterThanOrEqual(1);
      expect(STRICTNESS_LEVEL_BY_SQ2_ID[row.id]).toBeLessThanOrEqual(4);
    }
  });
});
