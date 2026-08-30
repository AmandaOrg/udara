/**
 * Maps LlmMessage image parts onto provider request bodies.
 * Orchestrator never persists these bytes; they exist for one turn.
 */

import { LlmMessage } from "./llm.types";

export { conversationProviderSupportsVision } from "./llm.types";

type AnthropicImageMedia =
  "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function anthropicMediaType(mimeType: string): AnthropicImageMedia {
  if (
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  ) {
    return mimeType;
  }
  return "image/jpeg";
}

export function messageHasImages(message: LlmMessage): boolean {
  return Array.isArray(message.images) && message.images.length > 0;
}

export function geminiPartsForMessage(
  message: LlmMessage,
): Array<
  { text: string } | { inlineData: { mimeType: string; data: string } }
> {
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];
  for (const image of message.images ?? []) {
    parts.push({
      inlineData: { mimeType: image.mimeType, data: image.data },
    });
  }
  if (message.content) {
    parts.push({ text: message.content });
  } else if (parts.length === 0) {
    parts.push({ text: "" });
  }
  return parts;
}

export function anthropicContentForMessage(message: LlmMessage):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: AnthropicImageMedia;
            data: string;
          };
        }
    > {
  if (!messageHasImages(message)) {
    return message.content;
  }
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: AnthropicImageMedia;
          data: string;
        };
      }
  > = [];
  for (const image of message.images ?? []) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: anthropicMediaType(image.mimeType),
        data: image.data,
      },
    });
  }
  blocks.push({ type: "text", text: message.content || "(user sent a photo)" });
  return blocks;
}
