import { parseNairaAmount } from "./naira-amount.util";

describe("parseNairaAmount", () => {
  it("keeps positive numbers", () => {
    expect(parseNairaAmount(5000)).toBe(5000);
    expect(parseNairaAmount(0)).toBeNull();
    expect(parseNairaAmount(-1)).toBeNull();
  });

  it("parses digits, commas, and naira sign", () => {
    expect(parseNairaAmount("5000")).toBe(5000);
    expect(parseNairaAmount("5,000")).toBe(5000);
    expect(parseNairaAmount("₦5,000")).toBe(5000);
  });

  it("parses k and thousand", () => {
    expect(parseNairaAmount("5k")).toBe(5000);
    expect(parseNairaAmount("5 k")).toBe(5000);
    expect(parseNairaAmount("5 thousand")).toBe(5000);
    expect(parseNairaAmount("2.5k")).toBe(2500);
  });

  it("parses common word amounts", () => {
    expect(parseNairaAmount("five thousand")).toBe(5000);
    expect(parseNairaAmount("twenty k")).toBe(20000);
  });

  it("does not guess from prose", () => {
    expect(parseNairaAmount("how much")).toBeNull();
    expect(parseNairaAmount("send it")).toBeNull();
  });
});
