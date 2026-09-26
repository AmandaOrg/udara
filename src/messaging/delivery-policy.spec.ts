import {
  decideDelivery,
  DeliveryPolicyService,
  RecipientState,
  WHATSAPP_WINDOW_MS,
} from "./delivery-policy";

const now = new Date("2026-09-26T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 3_600_000;

/** A WhatsApp user who has never opened the app: today's only kind of user. */
const whatsappOnly: RecipientState = {
  whatsappNumber: "2348010000001",
  lastInboundMessageAt: ago(HOUR),
  lastAppActiveAt: null,
  hasHadDevice: false,
  canPush: false,
};

/** Signed in to the app as well, and still signed in with push on. */
const both: RecipientState = {
  ...whatsappOnly,
  lastAppActiveAt: ago(2 * HOUR),
  hasHadDevice: true,
  canPush: true,
};

const appOnly: RecipientState = {
  whatsappNumber: null,
  lastInboundMessageAt: null,
  lastAppActiveAt: ago(HOUR),
  hasHadDevice: true,
  canPush: true,
};

describe("decideDelivery", () => {
  describe("someone who has never used the app", () => {
    it.each(["transactional", "proactive", "reply"] as const)(
      "gets a %s message on WhatsApp, exactly as before the app",
      (delivery) => {
        expect(decideDelivery({ delivery }, whatsappOnly, now)).toEqual({
          channel: "whatsapp",
          mirrorToApp: false,
          push: false,
        });
      },
    );

    it("still gets the WhatsApp attempt with the window closed, having nowhere else", () => {
      const lapsed = {
        ...whatsappOnly,
        lastInboundMessageAt: ago(2 * 24 * HOUR),
      };

      expect(
        decideDelivery({ delivery: "transactional" }, lapsed, now).channel,
      ).toBe("whatsapp");
    });
  });

  describe("someone who only uses the app", () => {
    it("gets everything in the app, with a push", () => {
      expect(decideDelivery({ delivery: "proactive" }, appOnly, now)).toEqual({
        channel: "app",
        mirrorToApp: false,
        push: true,
      });
    });

    it("gets a WhatsApp-origin result in the app too, having no WhatsApp", () => {
      expect(
        decideDelivery(
          { delivery: "transactional", origin: "whatsapp" },
          appOnly,
          now,
        ).channel,
      ).toBe("app");
    });

    it("gets no push from a phone that is signed out", () => {
      expect(
        decideDelivery(
          { delivery: "proactive" },
          { ...appOnly, canPush: false },
          now,
        ),
      ).toEqual({ channel: "app", mirrorToApp: false, push: false });
    });
  });

  describe("someone on both", () => {
    it("gets a payment's result where the payment was made", () => {
      expect(
        decideDelivery({ delivery: "transactional", origin: "app" }, both, now),
      ).toEqual({ channel: "app", mirrorToApp: false, push: true });
      expect(
        decideDelivery(
          { delivery: "transactional", origin: "whatsapp" },
          { ...both, lastAppActiveAt: ago(1000) },
          now,
        ),
      ).toEqual({ channel: "whatsapp", mirrorToApp: true, push: false });
    });

    it("gets a credit or a check-in wherever they were last", () => {
      expect(
        decideDelivery({ delivery: "transactional" }, both, now).channel,
      ).toBe("whatsapp");
      expect(
        decideDelivery(
          { delivery: "proactive" },
          { ...both, lastAppActiveAt: ago(1000) },
          now,
        ).channel,
      ).toBe("app");
    });

    /** Meta accepts a closed-window send and then fails it silently. */
    it("gets it in the app, with a push, instead of into a closed WhatsApp window", () => {
      const lapsed = {
        ...both,
        lastInboundMessageAt: ago(WHATSAPP_WINDOW_MS + 1000),
        lastAppActiveAt: ago(3 * 24 * HOUR),
      };

      expect(
        decideDelivery(
          { delivery: "transactional", origin: "whatsapp" },
          lapsed,
          now,
        ),
      ).toEqual({ channel: "app", mirrorToApp: false, push: true });
      expect(decideDelivery({ delivery: "proactive" }, lapsed, now)).toEqual({
        channel: "app",
        mirrorToApp: false,
        push: true,
      });
    });

    /** One event, one alert: WhatsApp is its own notification. */
    it("never pushes as well as sending on WhatsApp", () => {
      for (const delivery of ["transactional", "proactive"] as const) {
        const plan = decideDelivery({ delivery }, both, now);
        expect(plan.channel === "whatsapp" && plan.push).toBe(false);
      }
    });

    it("counts the window up to, not including, 24 hours", () => {
      const edge = {
        ...both,
        lastAppActiveAt: null,
        lastInboundMessageAt: ago(WHATSAPP_WINDOW_MS),
      };

      expect(decideDelivery({ delivery: "proactive" }, edge, now).channel).toBe(
        "app",
      );
    });
  });
});

describe("DeliveryPolicyService", () => {
  it("reads the recipient and only live, signed-in devices for push", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          whatsappNumber: null,
          lastInboundMessageAt: null,
          lastAppActiveAt: ago(HOUR),
        }),
      },
      device: {
        count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      },
    };
    const service = new DeliveryPolicyService(prisma as any);

    const plan = await service.plan(
      { id: "user-1" },
      { delivery: "proactive" },
      now,
    );

    expect(plan).toEqual({ channel: "app", mirrorToApp: false, push: false });
    expect(prisma.device.count).toHaveBeenLastCalledWith({
      where: {
        userId: "user-1",
        revokedAt: null,
        pushToken: { not: null },
        sessions: {
          some: { revokedAt: null, refreshExpiresAt: { gt: now } },
        },
      },
    });
  });
});
