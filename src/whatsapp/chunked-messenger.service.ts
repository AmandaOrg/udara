import { Injectable } from "@nestjs/common";
import { WhatsappService } from "./whatsapp.service";

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Splits model output into WhatsApp message bubbles on blank-line
 * boundaries. The model is instructed (kedu-persona prompt) to separate
 * distinct thoughts this way and to keep genuinely structured content
 * (lists, a budget breakdown) as a single block — this function doesn't try
 * to second-guess that judgment, it just honors the boundary the model drew.
 */
export function splitIntoChunks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

/**
 * Applies the Character & Tone doc's human-paced delay formula when sending
 * a (possibly multi-bubble) reply. The doc specified this belongs in "the
 * orchestration layer (n8n)" — n8n was replaced by this NestJS app per the
 * project's actual stack, so the delay logic lives here instead.
 *
 * Formula (randomized within each range, not fixed, per the doc):
 *  - initial "read" delay: 1-3s, or 3-6s if the first chunk is long (>30 words)
 *  - per-chunk "typing" delay: word count / (40-60 wpm)
 *  - gap between chunks: 0.5-1.5s
 */
@Injectable()
export class ChunkedMessengerService {
  constructor(private readonly whatsapp: WhatsappService) {}

  // Not private (TS-only, still a normal method at runtime) so tests can
  // jest.spyOn it to skip real timers instead of waiting out the delays.
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async sendChunkedReply(
    to: string,
    text: string,
    userId?: string,
  ): Promise<void> {
    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) return;

    const firstChunkWords = wordCount(chunks[0]);
    const readDelay =
      firstChunkWords > 30
        ? randomBetween(3000, 6000)
        : randomBetween(1000, 3000);
    await this.sleep(readDelay);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await this.sleep(randomBetween(500, 1500));
      }
      const wpm = randomBetween(40, 60);
      const typingMs = (wordCount(chunks[i]) / wpm) * 60 * 1000;
      await this.sleep(typingMs);
      await this.whatsapp.sendText(to, chunks[i], userId);
    }
  }
}
