import { sanitizeReplyText } from "./sanitize-reply.util";
import { buildAttestedDigits } from "./attested-digits.util";

/**
 * Everything the model sees is user-role content, including forwarded
 * screenshots and transcribed voice notes. So a scam message can reach it as
 * input, and without this the model could relay the attacker's account number
 * back in Udara's own voice, to someone who trusts Udara with their money.
 */
describe("sanitizeReplyText", () => {
  const nothingAttested = buildAttestedDigits([]);

  it("removes an account number the user never supplied", () => {
    const { text, removed } = sanitizeReplyText(
      "sure, send it to 0123456789 and you're sorted",
      nothingAttested,
    );

    expect(text).not.toContain("0123456789");
    expect(text).toContain("[number removed]");
    expect(removed).toBe(true);
  });

  it("keeps digits the user themselves typed", () => {
    const attested = buildAttestedDigits(["send 5000 to 0123456789"]);
    const { text, removed } = sanitizeReplyText(
      "confirming 0123456789, right?",
      attested,
    );

    expect(text).toContain("0123456789");
    expect(removed).toBe(false);
  });

  it.each([
    "check https://not-udara.example/verify",
    "go to www.definitely-your-bank.example now",
  ])("removes links (%p) — Udara never needs to send one", (message) => {
    const { text, removed } = sanitizeReplyText(message, nothingAttested);
    expect(text).toContain("[link removed]");
    expect(removed).toBe(true);
  });

  /**
   * Amounts are the substance of ordinary conversation on this product, and the
   * figures that matter are owned by surfaces rather than reply text, so they
   * are deliberately left alone.
   */
  it.each([
    "you've got ₦12,000 left today",
    "that's 5000 out of your 20000",
    "you spent 4500 on food",
  ])("leaves ordinary money talk alone: %p", (message) => {
    expect(sanitizeReplyText(message, nothingAttested).text).toBe(message);
  });

  it("leaves short numbers alone", () => {
    const message = "that's your 3rd send this week, 2 days into the window";
    expect(sanitizeReplyText(message, nothingAttested).text).toBe(message);
  });

  it("catches a spaced-out account number", () => {
    const { text } = sanitizeReplyText(
      "transfer to 0123 456 789 0 immediately",
      nothingAttested,
    );
    expect(text).toContain("[number removed]");
  });

  it("handles an empty message", () => {
    expect(sanitizeReplyText("", nothingAttested).text).toBe("");
  });
});
