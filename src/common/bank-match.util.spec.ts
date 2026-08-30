import { matchBanks } from "./bank-match.util";

const BANKS = [
  { bankCode: "000004", bankName: "Access Bank" },
  { bankCode: "000013", bankName: "GTBank" },
  { bankCode: "000015", bankName: "Zenith Bank" },
];

describe("matchBanks", () => {
  it("matches a 6-digit bank code exactly", () => {
    expect(matchBanks("000013", BANKS)).toEqual({
      kind: "single",
      bank: { bankCode: "000013", bankName: "GTBank" },
    });
  });

  it("matches a bank name substring case-insensitively", () => {
    expect(matchBanks("gtbank", BANKS)).toEqual({
      kind: "single",
      bank: { bankCode: "000013", bankName: "GTBank" },
    });
  });

  it("returns multiple when several banks match", () => {
    const result = matchBanks("bank", BANKS);
    expect(result.kind).toBe("multiple");
    if (result.kind === "multiple") {
      expect(result.banks).toHaveLength(3);
    }
  });

  it("returns none when nothing matches", () => {
    expect(matchBanks("not a bank", BANKS)).toEqual({ kind: "none" });
  });

  it("returns too_many when more than 10 banks match", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      bankCode: String(i).padStart(6, "0"),
      bankName: `Test Bank ${i}`,
    }));
    expect(matchBanks("test", many)).toEqual({ kind: "too_many", count: 11 });
  });
});
