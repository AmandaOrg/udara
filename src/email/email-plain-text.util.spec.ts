import { htmlToPlainText } from "./email-plain-text.util";

describe("htmlToPlainText", () => {
  it("strips tags and preserves paragraph breaks", () => {
    const text = htmlToPlainText(
      "<p>hey Alex,</p><p>here's your August 2026 recap.</p>",
    );
    expect(text).toContain("hey Alex,");
    expect(text).toContain("August 2026 recap.");
  });

  it("decodes common entities", () => {
    expect(htmlToPlainText("<p>₦1,500 &amp; more</p>")).toContain("₦1,500 & more");
  });
});
