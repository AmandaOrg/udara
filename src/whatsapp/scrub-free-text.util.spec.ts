import { scrubFreeTextSecrets } from "./scrub-free-text.util";

/**
 * Field-name redaction covers the WhatsApp Flow path completely. This covers
 * the case it cannot: a user typing a secret as an ordinary chat message, which
 * happens most often when a Flow fails to open and they improvise.
 */
describe("scrubFreeTextSecrets", () => {
  it.each([
    "my pin is 1234",
    "PIN: 4321",
    "pin 123456",
    "the otp is 998877",
    "my bvn is 12345678901",
    "BVN 12345678901",
    "nin: 22334455667",
  ])("redacts a labelled secret in %p", (text) => {
    expect(scrubFreeTextSecrets(text)).not.toMatch(/\d{4}/);
    expect(scrubFreeTextSecrets(text)).toContain("[redacted]");
  });

  it("keeps the label so the message still reads sensibly", () => {
    expect(scrubFreeTextSecrets("my pin is 1234")).toBe("my pin is [redacted]");
  });

  /**
   * The rule that matters most. Redacting every 11-digit run would catch every
   * BVN — and also every Nigerian mobile number, breaking airtime and data
   * purchases outright. A bare 11-digit number is far more often a phone number
   * than a volunteered BVN, so labelled digits only.
   */
  it.each([
    "08031234567",
    "buy 500 airtime for 08031234567",
    "send 5000 to 0123456789",
    "my meter is 45012345678",
    "234 8031234567",
  ])("leaves unlabelled numbers alone in %p", (text) => {
    expect(scrubFreeTextSecrets(text)).toBe(text);
  });

  it("does not touch ordinary money talk", () => {
    const text = "i spent 12000 on food this week";
    expect(scrubFreeTextSecrets(text)).toBe(text);
  });

  it("handles empty input", () => {
    expect(scrubFreeTextSecrets("")).toBe("");
  });

  it("redacts more than one secret in the same message", () => {
    const scrubbed = scrubFreeTextSecrets("pin 1234 and bvn 12345678901");
    expect(scrubbed).not.toContain("1234");
    expect(scrubbed).not.toContain("12345678901");
  });
});
