import {
  anthropicContentForMessage,
  conversationProviderSupportsVision,
  geminiPartsForMessage,
} from "./llm-vision.util";

describe("llm-vision.util", () => {
  it("supports vision only for gemini and anthropic", () => {
    expect(conversationProviderSupportsVision("gemini")).toBe(true);
    expect(conversationProviderSupportsVision("anthropic")).toBe(true);
    expect(conversationProviderSupportsVision("bedrock")).toBe(false);
    expect(conversationProviderSupportsVision("stub")).toBe(false);
  });

  it("puts Gemini inlineData before caption text", () => {
    expect(
      geminiPartsForMessage({
        role: "user",
        content: "this receipt",
        images: [{ mimeType: "image/jpeg", data: "abc" }],
      }),
    ).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "abc" } },
      { text: "this receipt" },
    ]);
  });

  it("keeps Anthropic content as a string when there is no image", () => {
    expect(anthropicContentForMessage({ role: "user", content: "hello" })).toBe(
      "hello",
    );
  });

  it("builds Anthropic image + text blocks", () => {
    expect(
      anthropicContentForMessage({
        role: "user",
        content: "pay this",
        images: [{ mimeType: "image/png", data: "xyz" }],
      }),
    ).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "xyz" },
      },
      { type: "text", text: "pay this" },
    ]);
  });
});
