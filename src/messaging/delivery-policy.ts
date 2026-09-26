import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { Channel } from "./channel-context";

/** Meta refuses free-form messages this long after the user's last WhatsApp message. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RecipientState {
  whatsappNumber: string | null;
  lastInboundMessageAt: Date | null;
  lastAppActiveAt: Date | null;
  /** Signed in to the app at least once, so the app chat is somewhere they will look. */
  hasHadDevice: boolean;
  /** A device that is signed in, not revoked, and has a push token. */
  canPush: boolean;
}

export interface DeliveryRequest {
  delivery: "reply" | "transactional" | "proactive";
  /** The channel a payment was quoted on, for its result. */
  origin?: Channel;
}

export interface DeliveryPlan {
  channel: Channel;
  /** Also write it to the app chat, silently, so the app's history is whole. */
  mirrorToApp: boolean;
  push: boolean;
}

/**
 * Where a message goes when nobody is waiting for a reply: a transfer that
 * resolved later, money arriving, a check-in, the managers' answer.
 *
 * One rule above the rest: exactly one channel alerts the user. A WhatsApp
 * message is its own alert, so it never also pushes; the app chat alerts
 * through a push.
 */
export function decideDelivery(
  request: DeliveryRequest,
  state: RecipientState,
  now: Date = new Date(),
): DeliveryPlan {
  const preferred = preferredChannel(request, state);
  const windowOpen =
    !!state.lastInboundMessageAt &&
    now.getTime() - state.lastInboundMessageAt.getTime() < WHATSAPP_WINDOW_MS;

  if (preferred === "whatsapp" && (windowOpen || !state.hasHadDevice)) {
    // A WhatsApp-only user outside the window still gets the attempt: there
    // is nowhere else to send it, and it is what happened before the app.
    return {
      channel: "whatsapp",
      mirrorToApp: state.hasHadDevice,
      push: false,
    };
  }
  return { channel: "app", mirrorToApp: false, push: state.canPush };
}

function preferredChannel(
  request: DeliveryRequest,
  state: RecipientState,
): Channel {
  if (!state.whatsappNumber) return "app";
  if (request.delivery === "transactional" && request.origin) {
    return request.origin;
  }
  // Wherever they were last: that is where they will look.
  const app = state.lastAppActiveAt?.getTime() ?? -Infinity;
  const whatsapp = state.lastInboundMessageAt?.getTime() ?? -Infinity;
  return app > whatsapp ? "app" : "whatsapp";
}

/** Reads what decideDelivery needs about a user. */
@Injectable()
export class DeliveryPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async plan(
    to: { id: string },
    request: DeliveryRequest,
    now: Date = new Date(),
  ): Promise<DeliveryPlan> {
    const userId = to.id;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        whatsappNumber: true,
        lastInboundMessageAt: true,
        lastAppActiveAt: true,
      },
    });
    if (!user) {
      // Nothing to reach; the adapters drop it with their own log line.
      return { channel: "whatsapp", mirrorToApp: false, push: false };
    }
    const [devices, pushable] = await Promise.all([
      this.prisma.device.count({ where: { userId } }),
      this.prisma.device.count({ where: pushableDevices(userId, now) }),
    ]);
    return decideDelivery(
      request,
      { ...user, hasHadDevice: devices > 0, canPush: pushable > 0 },
      now,
    );
  }
}

/**
 * Devices a push may go to: not revoked, holding a token, and still signed
 * in. A phone that signed out, or whose sessions were revoked as stolen, gets
 * nothing, even though its token is still on the row.
 */
export function pushableDevices(userId: string, now: Date) {
  return {
    userId,
    revokedAt: null,
    pushToken: { not: null },
    sessions: {
      some: { revokedAt: null, refreshExpiresAt: { gt: now } },
    },
  };
}
