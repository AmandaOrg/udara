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

  it("drops LLM chatter before a read surface", () => {
    expect(
      sanitizeSurfaceLeadIn(
        "hey Esammy, still here. what's on your mind?",
        "balance_read",
      ),
    ).toBe("");
  });

  it("keeps a short transfer lead-in", () => {
    expect(sanitizeSurfaceLeadIn("on it, Esammy.", "transfer_wizard")).toBe(
      "on it, Esammy.",
    );
  });
});
