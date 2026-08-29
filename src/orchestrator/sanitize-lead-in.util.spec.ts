import {
  collapseToSingleBubble,
  sanitizeSurfaceLeadIn,
} from "./sanitize-lead-in.util";

describe("sanitizeSurfaceLeadIn", () => {
  it("collapses blank-line chunks into one bubble", () => {
    expect(collapseToSingleBubble("on it.\n\nconfirming now.")).toBe(
      "on it. confirming now.",
    );
  });

  it("strips invented naira amounts from balance lead-ins", () => {
    expect(
      sanitizeSurfaceLeadIn(
        "pulling that up for you now, Esammy. account balance: ₦1,000",
        "balance_read",
      ),
    ).toBe("pulling that up now.");
  });

  it("keeps a short transfer lead-in", () => {
    expect(sanitizeSurfaceLeadIn("on it, Esammy.", "transfer_wizard")).toBe(
      "on it, Esammy.",
    );
  });
});
