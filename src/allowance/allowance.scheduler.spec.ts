import { AllowanceScheduler } from "./allowance.scheduler";
import { NudgeType } from "@prisma/client";

describe("AllowanceScheduler", () => {
  let prisma: {
    user: { findMany: jest.Mock };
    nudgeLog: { findFirst: jest.Mock; create: jest.Mock };
    dailyAllowance: Record<string, never>;
  };
  let allowance: { getOrCreateTodayAllowance: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendTemplate: jest.Mock };
  let config: { get: jest.Mock };
  let scheduler: AllowanceScheduler;

  function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "user-1",
      whatsappNumber: "234801",
      windowStartHour: 11,
      lastInboundMessageAt: new Date(),
      rubiesAccountNumber: "7712345678",
      ...overrides,
    };
  }

  beforeEach(() => {
    // An explicit UTC instant (never the local Date constructor) that is
    // 11 AM WAT — this is what actually exercises getWatHour's WAT-anchoring
    // (see wat-time.util.ts) regardless of the machine/CI's own timezone.
    jest.useFakeTimers().setSystemTime(new Date("2026-01-08T10:00:00Z"));
    prisma = {
      user: { findMany: jest.fn() },
      nudgeLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      dailyAllowance: {},
    };
    allowance = { getOrCreateTodayAllowance: jest.fn() };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendTemplate: jest.fn().mockResolvedValue({ waMessageId: "wamid.2" }),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    scheduler = new AllowanceScheduler(
      prisma as any,
      allowance as any,
      whatsapp as any,
      config as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("handleDailyBoundary", () => {
    it("pre-warms today's allowance for every active (has a Rubies account) user", async () => {
      prisma.user.findMany.mockResolvedValue([
        makeUser({ id: "u1" }),
        makeUser({ id: "u2" }),
      ]);

      await scheduler.handleDailyBoundary();

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            rubiesAccountNumber: { not: null },
          }),
        }),
      );
      expect(allowance.getOrCreateTodayAllowance).toHaveBeenCalledWith("u1");
      expect(allowance.getOrCreateTodayAllowance).toHaveBeenCalledWith("u2");
    });

    it("doesn't let one user's failure block pre-warming the rest", async () => {
      prisma.user.findMany.mockResolvedValue([
        makeUser({ id: "u1" }),
        makeUser({ id: "u2" }),
      ]);
      allowance.getOrCreateTodayAllowance
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({});

      await expect(scheduler.handleDailyBoundary()).resolves.not.toThrow();
      expect(allowance.getOrCreateTodayAllowance).toHaveBeenCalledTimes(2);
    });
  });

  describe("sendWindowOpenNudges", () => {
    it("only queries users whose windowStartHour matches the current hour", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      await scheduler.sendWindowOpenNudges();
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ windowStartHour: 11 }),
        }),
      );
    });

    it("sends a free-form text when lastInboundMessageAt is within 24h, and logs it", async () => {
      const user = makeUser();
      prisma.user.findMany.mockResolvedValue([user]);

      await scheduler.sendWindowOpenNudges();

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        "user-1",
      );
      expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
      expect(prisma.nudgeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: "user-1",
            type: NudgeType.WINDOW_OPEN,
            channel: "freeform",
          },
        }),
      );
    });

    it("falls back to a template when outside the 24h free-form window", async () => {
      const user = makeUser({ lastInboundMessageAt: new Date(2026, 0, 1) }); // long ago
      prisma.user.findMany.mockResolvedValue([user]);
      config.get.mockReturnValue("window_open_v1");

      await scheduler.sendWindowOpenNudges();

      expect(whatsapp.sendTemplate).toHaveBeenCalledWith(
        "234801",
        "window_open_v1",
        "en_US",
        undefined,
        "user-1",
      );
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(prisma.nudgeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: "user-1",
            type: NudgeType.WINDOW_OPEN,
            channel: "template",
            templateName: "window_open_v1",
          },
        }),
      );
    });

    it("skips (does not throw, does not log) when outside the 24h window with no template configured", async () => {
      const user = makeUser({ lastInboundMessageAt: new Date(2026, 0, 1) });
      prisma.user.findMany.mockResolvedValue([user]);
      config.get.mockReturnValue(undefined);

      await scheduler.sendWindowOpenNudges();

      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
      expect(prisma.nudgeLog.create).not.toHaveBeenCalled();
    });

    it("treats a user who has never messaged in (lastInboundMessageAt null) as outside the free-form window", async () => {
      const user = makeUser({ lastInboundMessageAt: null });
      prisma.user.findMany.mockResolvedValue([user]);
      config.get.mockReturnValue("window_open_v1");

      await scheduler.sendWindowOpenNudges();

      expect(whatsapp.sendTemplate).toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it("does not send a second nudge the same day (NudgeLog dedup)", async () => {
      const user = makeUser();
      prisma.user.findMany.mockResolvedValue([user]);
      prisma.nudgeLog.findFirst.mockResolvedValue({ id: "existing-nudge" });

      await scheduler.sendWindowOpenNudges();

      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(prisma.nudgeLog.create).not.toHaveBeenCalled();
    });

    it("leaves no NudgeLog row if the WhatsApp send itself fails, so the next tick retries", async () => {
      const user = makeUser();
      prisma.user.findMany.mockResolvedValue([user]);
      whatsapp.sendText.mockRejectedValue(new Error("Meta API down"));

      await expect(scheduler.sendWindowOpenNudges()).resolves.not.toThrow();

      expect(prisma.nudgeLog.create).not.toHaveBeenCalled();
    });

    it("does nothing when no users are due this hour", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      await scheduler.sendWindowOpenNudges();
      expect(prisma.nudgeLog.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("sendHabitFormingFollowUps", () => {
    it("queries users whose onboardingCompletedAt falls in the 10-11h-ago window", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      await scheduler.sendHabitFormingFollowUps();
      const call = prisma.user.findMany.mock.calls[0][0];
      const { gte, lte } = call.where.onboardingCompletedAt;
      expect(lte.getTime() - gte.getTime()).toBe(60 * 60 * 1000); // exactly a 1h window
      expect(Date.now() - lte.getTime()).toBeCloseTo(10 * 60 * 60 * 1000, -3);
    });

    it("sends once and logs it via NudgeLog, with no daily-style sentAt bound (once ever)", async () => {
      const user = makeUser({ onboardingCompletedAt: new Date() });
      prisma.user.findMany.mockResolvedValue([user]);

      await scheduler.sendHabitFormingFollowUps();

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        "user-1",
      );
      expect(prisma.nudgeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: NudgeType.HABIT_FORMING_FOLLOWUP,
          }),
        }),
      );
      const findFirstCall = prisma.nudgeLog.findFirst.mock.calls[0][0];
      expect(findFirstCall.where).toEqual({
        userId: "user-1",
        type: NudgeType.HABIT_FORMING_FOLLOWUP,
      });
    });

    it("never sends a second time once already logged", async () => {
      const user = makeUser({ onboardingCompletedAt: new Date() });
      prisma.user.findMany.mockResolvedValue([user]);
      prisma.nudgeLog.findFirst.mockResolvedValue({ id: "already-sent" });

      await scheduler.sendHabitFormingFollowUps();

      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });
});
