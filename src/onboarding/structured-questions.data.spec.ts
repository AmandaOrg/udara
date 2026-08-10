import {
  STRUCTURED_QUESTIONS,
  STRICTNESS_LEVEL_BY_SQ4_ID,
  INCOME_POSTURE_GROW_SQ1_ID,
} from "./structured-questions.data";

describe("STRUCTURED_QUESTIONS", () => {
  it("has 4 questions, matching the onboarding script", () => {
    expect(STRUCTURED_QUESTIONS).toHaveLength(4);
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

  it("every sq4 row id has a strictness level mapping", () => {
    const sq4 = STRUCTURED_QUESTIONS.find((q) => q.key === "sq4");
    for (const row of sq4?.rows ?? []) {
      expect(STRICTNESS_LEVEL_BY_SQ4_ID[row.id]).toBeGreaterThanOrEqual(1);
      expect(STRICTNESS_LEVEL_BY_SQ4_ID[row.id]).toBeLessThanOrEqual(4);
    }
  });

  it("INCOME_POSTURE_GROW_SQ1_ID matches an actual sq1 row", () => {
    const sq1 = STRUCTURED_QUESTIONS.find((q) => q.key === "sq1");
    expect(sq1?.rows.some((r) => r.id === INCOME_POSTURE_GROW_SQ1_ID)).toBe(
      true,
    );
  });
});
