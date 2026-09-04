import { parseLimitAnswer, parseNairaAmount } from "./naira-amount.util";

/**
 * These are the phrasings that silently killed the Sunday "Adjust limits" flow:
 * the user answered the question we asked, the strict parser returned null, and
 * the review was closed with no override and no message.
 */
describe("parseLimitAnswer", () => {
  it.each([
    ["5000", 5000],
    ["5k", 5000],
    ["5,000", 5000],
    ["₦5,000", 5000],
    ["5000 naira", 5000],
    ["5000 a day", 5000],
    ["5k per day", 5000],
    ["7000/day", 7000],
    ["make it 5k", 5000],
    ["let's do 5000", 5000],
    ["i want 5000", 5000],
    ["5000 please", 5000],
    ["5000.", 5000],
    ["five thousand", 5000],
    ["Five thousand.", 5000],
    ["5000 naira a day please", 5000],
  ])("reads %p as %p", (input, expected) => {
    expect(parseLimitAnswer(input)).toBe(expected);
  });

  it.each(["how much", "i don't know", "cancel", "(user sent a photo)", ""])(
    "still refuses %p, which is not an answer at all",
    (input) => {
      expect(parseLimitAnswer(input)).toBeNull();
    },
  );

  /**
   * The strict parser decides what a wizard does with free text, where reading
   * an amount out of prose would move money the user did not ask to move. It
   * must not become lenient by accident.
   */
  it("leaves the strict parser's contract untouched", () => {
    expect(parseNairaAmount("5000 naira")).toBeNull();
    expect(parseNairaAmount("make it 5k")).toBeNull();
    expect(parseNairaAmount("5000")).toBe(5000);
  });
});
