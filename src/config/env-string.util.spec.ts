import { normalizeEnvString } from "./env-string.util";

describe("normalizeEnvString", () => {
  it("trims and unwraps quoted values", () => {
    expect(normalizeEnvString(' "gemini" ')).toBe("gemini");
    expect(normalizeEnvString("")).toBe("");
  });
});
