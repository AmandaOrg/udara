import { Injectable } from "@nestjs/common";
import { WhatsappMessageDirection } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
 * Sends a (possibly multi-bubble) reply, one WhatsappService.sendText call
 * per chunk. An earlier version of this simulated human typing speed via a
 * per-word sleep (word count / 40-60wpm) plus a multi-second "read delay" up
 * front — for anything longer than a couple sentences that added tens of
 * seconds of pure artificial latency on top of the real LLM/network time,
 * which made replies feel slow. That's gone; what's left is a deliberate
 * ~4s pause between bubbles (product decision: reads as a person typing each
 * message rather than a bot dumping a wall of text), with WhatsApp's native
 * "typing…" indicator re-shown for each pause so the gap doesn't read as
 * dead air. The first bubble sends immediately — WhatsappController already
 * fires the typing indicator the moment the inbound message arrives, so
 * there's nothing to add before the first send.
 */
@Injectable()
export class ChunkedMessengerService {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly prisma: PrismaService,
  ) {}

  // Not private (TS-only, still a normal method at runtime) so tests can
  // jest.spyOn it to skip real timers instead of waiting out the delays.
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Re-triggers the typing indicator ahead of the next bubble. Meta ties
   * typing-indicator display to marking a specific inbound message as read,
   * so this looks up the user's most recent inbound message rather than
   * threading a waMessageId through every caller of sendChunkedReply — it's
   * a best-effort UX nicety and must never fail (or slow down) the actual
   * send if it can't find one or the call errors.
   */
  private async showTyping(to: string): Promise<void> {
    const lastInbound = await this.prisma.whatsappMessage.findFirst({
      where: { fromNumber: to, direction: WhatsappMessageDirection.INBOUND },
      orderBy: { createdAt: "desc" },
      select: { waMessageId: true },
    });
    if (!lastInbound) return;
    await this.whatsapp
      .markAsReadWithTyping(lastInbound.waMessageId)
      .catch(() => {});
  }

  async sendChunkedReply(
    to: string,
    text: string,
    userId?: string,
  ): Promise<void> {
    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) return;

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await this.showTyping(to);
        await this.sleep(randomBetween(3500, 4500));
      }
      await this.whatsapp.sendText(to, chunks[i], userId);
    }
  }
}
