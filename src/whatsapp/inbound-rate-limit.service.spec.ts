import {
  InboundRateLimitService,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
} from "./inbound-rate-limit.service";
import { WhatsappMessageDirection } from "@prisma/client";

/**
 * Any WhatsApp number that has never been seen gets a User row and, past the
 * first two scripted turns, an LLM call per message; voice notes add a media
 * download and a transcription. Nothing bounded that before this service.
 */
describe("InboundRateLimitService", () => {
  let prisma: { whatsappMessage: { count: jest.Mock } };
  let service: InboundRateLimitService;
  const now = new Date("2026-09-04T12:00:00Z");

  beforeEach(() => {
    prisma = { whatsappMessage: { count: jest.fn() } };
    service = new InboundRateLimitService(prisma as any);
  });

  it("lets an ordinary conversation through", async () => {
    prisma.whatsappMessage.count.mockResolvedValue(5);

    await expect(service.check("user-1", now)).resolves.toEqual({
      limited: false,
      justCrossed: false,
    });
  });

  it("counts only this user's inbound messages, inside the window", async () => {
    prisma.whatsappMessage.count.mockResolvedValue(0);

    await service.check("user-1", now);

    expect(prisma.whatsappMessage.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        direction: WhatsappMessageDirection.INBOUND,
        createdAt: { gte: new Date(now.getTime() - RATE_LIMIT_WINDOW_MS) },
      },
    });
  });

  it("allows exactly the limit, and blocks the one after it", async () => {
    prisma.whatsappMessage.count.mockResolvedValue(RATE_LIMIT_MAX_MESSAGES);
    expect((await service.check("user-1", now)).limited).toBe(false);

    prisma.whatsappMessage.count.mockResolvedValue(RATE_LIMIT_MAX_MESSAGES + 1);
    expect((await service.check("user-1", now)).limited).toBe(true);
  });

  /**
   * Replying to every throttled message would cost one outbound send per
   * inbound message, which is the spend this service exists to stop. So the
   * boundary message gets an explanation and everything after it is silent.
   */
  it("explains itself once at the boundary, then stays quiet", async () => {
    prisma.whatsappMessage.count.mockResolvedValue(RATE_LIMIT_MAX_MESSAGES + 1);
    expect((await service.check("user-1", now)).justCrossed).toBe(true);

    prisma.whatsappMessage.count.mockResolvedValue(
      RATE_LIMIT_MAX_MESSAGES + 20,
    );
    const later = await service.check("user-1", now);
    expect(later.limited).toBe(true);
    expect(later.justCrossed).toBe(false);
  });
});
