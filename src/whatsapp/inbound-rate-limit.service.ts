import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappMessageDirection } from "@prisma/client";

/**
 * Per-user ceiling on inbound messages, because every one of them can cost
 * real money.
 *
 * Any WhatsApp number that has never been seen gets a User row and, once past
 * the first two scripted turns, an LLM call for every message it sends;
 * voice notes additionally cost a Meta media download and a Deepgram
 * transcription. Nothing bounded that. `LlmCallLog` records the spend but is
 * never read back, so there was no cap and no alarm — one hostile number could
 * run up the bill indefinitely.
 *
 * Counted from `WhatsappMessage`, which already carries the right index
 * (`@@index([userId, createdAt])`), so this needs no new table and stays
 * correct across replicas. The limit is deliberately well above any plausible
 * human conversation: it exists to stop automated abuse, not to ration a
 * customer who is typing quickly.
 */
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_MAX_MESSAGES = 40;

@Injectable()
export class InboundRateLimitService {
  private readonly logger = new Logger(InboundRateLimitService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True when this user has already exceeded the window and should be ignored.
   *
   * The caller sends one notice at the boundary and then stays silent: replying
   * to every throttled message would itself be an outbound send per inbound
   * message, which is the cost we are trying to avoid.
   */
  async check(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ limited: boolean; justCrossed: boolean }> {
    const count = await this.prisma.whatsappMessage.count({
      where: {
        userId,
        direction: WhatsappMessageDirection.INBOUND,
        createdAt: { gte: new Date(now.getTime() - RATE_LIMIT_WINDOW_MS) },
      },
    });

    if (count <= RATE_LIMIT_MAX_MESSAGES) {
      return { limited: false, justCrossed: false };
    }

    // The message that crosses the line gets one explanation; everything after
    // it is dropped without a reply.
    const justCrossed = count === RATE_LIMIT_MAX_MESSAGES + 1;
    if (justCrossed) {
      this.logger.warn(
        `user ${userId} crossed the inbound rate limit (${count} messages in ${RATE_LIMIT_WINDOW_MS / 60_000} minutes)`,
      );
    }
    return { limited: true, justCrossed };
  }
}
