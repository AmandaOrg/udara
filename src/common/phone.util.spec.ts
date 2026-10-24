import { isNigerianMobile, normalizePhoneNumber } from "./phone.util";

/**
 * One canonical form is what makes a number typed into the app and the same
 * number messaging on WhatsApp the same account, so every way of writing the
 * number has to land on the WhatsApp sender id.
 */
describe("normalizePhoneNumber", () => {
  it.each([
    ["2348012345678", "a WhatsApp sender id, unchanged"],
    ["+2348012345678", "E.164"],
    ["+234 801 234 5678", "E.164 with spaces"],
    ["002348012345678", "international dialling prefix"],
    ["08012345678", "Nigerian local form"],
    ["0801-234-5678", "Nigerian local form with dashes"],
    ["(0801) 234 5678", "Nigerian local form with brackets"],
    ["8012345678", "Nigerian number without its trunk zero"],
    ["+234 0801 234 5678", "trunk zero kept after the country code"],
  ])("reads %s (%s) as 2348012345678", (raw) => {
    expect(normalizePhoneNumber(raw)).toBe("2348012345678");
  });

  it("keeps a non-Nigerian WhatsApp number as it is", () => {
    expect(normalizePhoneNumber("447700900123")).toBe("447700900123");
    expect(normalizePhoneNumber("+44 7700 900123")).toBe("447700900123");
  });

  it.each([
    [""],
    ["hello"],
    ["12345"],
    ["+0123456789"],
    ["1234567890123456"],
    ["0801234567"],
  ])("rejects %j", (raw) => {
    expect(normalizePhoneNumber(raw)).toBeNull();
  });
});

describe("isNigerianMobile", () => {
  it("accepts 234 followed by a 7, 8 or 9 mobile prefix", () => {
    expect(isNigerianMobile("2347012345678")).toBe(true);
    expect(isNigerianMobile("2348012345678")).toBe(true);
    expect(isNigerianMobile("2349012345678")).toBe(true);
  });

  it("rejects landlines, other countries and non-canonical forms", () => {
    expect(isNigerianMobile("2341012345678")).toBe(false);
    expect(isNigerianMobile("447700900123")).toBe(false);
    expect(isNigerianMobile("08012345678")).toBe(false);
    expect(isNigerianMobile("+2348012345678")).toBe(false);
  });
});
