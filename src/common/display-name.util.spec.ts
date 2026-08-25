import {
  displayFirstNameOrThere,
  formatDisplayFirstName,
} from "./display-name.util";

describe("formatDisplayFirstName", () => {
  it("title-cases a lowercase first name", () => {
    expect(formatDisplayFirstName("ada")).toBe("Ada");
    expect(formatDisplayFirstName("ada lovelace")).toBe("Ada");
  });

  it("normalizes already-caps names", () => {
    expect(formatDisplayFirstName("DANIEL")).toBe("Daniel");
  });

  it("returns null for empty or placeholder", () => {
    expect(formatDisplayFirstName("")).toBeNull();
    expect(formatDisplayFirstName("there")).toBeNull();
    expect(formatDisplayFirstName(null)).toBeNull();
  });
});

describe("displayFirstNameOrThere", () => {
  it("falls back to there when name missing", () => {
    expect(displayFirstNameOrThere(null)).toBe("there");
    expect(displayFirstNameOrThere("chidi")).toBe("Chidi");
  });
});
