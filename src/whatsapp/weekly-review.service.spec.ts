import { WeeklyReviewService } from "./weekly-review.service";
import { Prisma, RecipientLabel, WeeklyReviewStatus } from "@prisma/client";

describe("WeeklyReviewService", () => {
  let prisma: {
    weeklyReview: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    user: { update: jest.Mock };
  };
  let allowance: {
    getOrCreateTodayAllowance: jest.Mock;
    computePlannedDailyAmount: jest.Mock;
  };
  let spendSummary: { getWeeklySummary: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendInteractiveButtons: jest.Mock };
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let service: WeeklyReviewService;

  // A Sunday: 2026-01-11 is a Sunday. 18:00 WAT = 17:00 UTC.
  const sunday = new Date("2026-01-11T17:00:00Z");

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    name: "Daniel Okafor",
    monthlyIncome: 1_500_000,
  } as any;

  /** Everything sent to the user this test, joined. */
  function allSent(): string {
    return [
      ...chunkedMessenger.sendChunkedReply.mock.calls.map((c: any[]) => c[1]),
      ...whatsapp.sendText.mock.calls.map((c: any[]) => c[1]),
      ...whatsapp.sendInteractiveButtons.mock.calls.map((c: any[]) => c[1]),
    ].join("\n");
  }

  beforeEach(() => {
    prisma = {
      weeklyReview: {
        create: jest.fn().mockResolvedValue({ id: "wr-1" }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
    };
    allowance = {
      // 1.5M * 30% / 30 = 15,000/day
      getOrCreateTodayAllowance: jest
        .fn()
        .mockResolvedValue({ amountAllocated: 15_000 }),
      computePlannedDailyAmount: jest.fn().mockReturnValue(15_000),
    };
    spendSummary = {
      getWeeklySummary: jest.fn().mockResolvedValue({
        totalSpent: 62_000,
        transactionCount: 9,
        byLabel: {
          [RecipientLabel.FOOD]: 40_000,
          [RecipientLabel.OTHER]: 22_000,
        },
        byDay: [],
      }),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }),
      sendInteractiveButtons: jest
        .fn()
        .mockResolvedValue({ waMessageId: "w2" }),
    };
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    service = new WeeklyReviewService(
      prisma as any,
      allowance as any,
      spendSummary as any,
      whatsapp as any,
      chunkedMessenger as any,
    );
  });

  describe("sending the recap", () => {
    it("reports the spend against the weekly allowance and offers both choices", async () => {
      const sent = await service.sendReview(user, sunday);

      expect(sent).toBe(true);
      const text = allSent();
      expect(text).toContain("₦62,000");
      expect(text).toContain("9 transactions");
      expect(text).toContain("₦105,000"); // 15,000 x 7
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("keep it"),
        expect.arrayContaining([
          expect.objectContaining({ id: "weekly:keep" }),
          expect.objectContaining({ id: "weekly:adjust" }),
        ]),
        "user-1",
      );
    });

    it("says they stayed inside the limit, with the amount to spare", async () => {
      await service.sendReview(user, sunday);
      expect(allSent()).toContain("₦43,000 to spare"); // 105,000 - 62,000
    });

    it("says by how much they went over when they did", async () => {
      spendSummary.getWeeklySummary.mockResolvedValue({
        totalSpent: 130_000,
        transactionCount: 12,
        byLabel: {},
        byDay: [],
      });
      await service.sendReview(user, sunday);
      expect(allSent()).toContain("went over by ₦25,000"); // 130,000 - 105,000
    });

    it("handles a zero-spend week without pretending it's automatically a win", async () => {
      spendSummary.getWeeklySummary.mockResolvedValue({
        totalSpent: 0,
        transactionCount: 0,
        byLabel: {},
        byDay: [],
      });
      await service.sendReview(user, sunday);
      expect(allSent()).toContain("somewhere i can't see");
    });

    it("does not double-send when a review already exists for the week", async () => {
      prisma.weeklyReview.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dupe", {
          code: "P2002",
          clientVersion: "5.22.0",
          meta: { target: ["userId", "weekStartDate"] },
        }),
      );

      const sent = await service.sendReview(user, sunday);

      expect(sent).toBe(false);
      expect(whatsapp.sendInteractiveButtons).not.toHaveBeenCalled();
    });
  });

  describe("keep vs adjust", () => {
    beforeEach(() => {
      prisma.weeklyReview.findFirst.mockResolvedValue({
        id: "wr-1",
        status: WeeklyReviewStatus.SENT,
      });
    });

    it("'keep' completes the review and writes no override", async () => {
      await service.handleChoice(user, "weekly:keep");

      expect(prisma.weeklyReview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeeklyReviewStatus.COMPLETED,
          }),
        }),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("'adjust' moves to AWAITING_LIMIT and asks for a number", async () => {
      await service.handleChoice(user, "weekly:adjust");

      expect(prisma.weeklyReview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: WeeklyReviewStatus.AWAITING_LIMIT },
        }),
      );
      expect(allSent()).toContain("₦15,000");
    });

    it("tells the user plainly when the check-in was already answered", async () => {
      prisma.weeklyReview.findFirst.mockResolvedValue(null);

      await service.handleChoice(user, "weekly:keep");

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(allSent()).toContain("already been answered");
    });
  });

  describe("setting a new limit", () => {
    const review = {
      id: "wr-1",
      status: WeeklyReviewStatus.AWAITING_LIMIT,
    } as any;

    it("accepts a plain number and scopes the override to the coming week", async () => {
      await service.handleLimitText(user, review, "12000", sunday);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(Number(data.dailyLimitOverride)).toBe(12_000);
      // Sunday is the last day of its WAT ISO week, so the choice applies to
      // the week starting the next day (Monday 2026-01-12).
      expect(data.dailyLimitOverrideWeekStart.toISOString().slice(0, 10)).toBe(
        "2026-01-12",
      );
      expect(allSent()).toContain("₦84,000"); // 12,000 x 7
    });

    it("tolerates naira signs and separators", async () => {
      await service.handleLimitText(user, review, "₦12,000", sunday);
      expect(
        Number(prisma.user.update.mock.calls[0][0].data.dailyLimitOverride),
      ).toBe(12_000);
    });

    it("rejects non-numeric input and leaves the review open to retry", async () => {
      await service.handleLimitText(user, review, "a bit more", sunday);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.weeklyReview.update).not.toHaveBeenCalled();
      expect(allSent()).toContain("didn't read as an amount");
    });

    it("rejects an implausibly low limit", async () => {
      await service.handleLimitText(user, review, "5", sunday);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(allSent()).toContain("too low");
    });

    it("refuses to let 'adjust limits' become 'switch discipline off'", async () => {
      // Ceiling is 2x the derived plan: 15,000 -> 30,000.
      await service.handleLimitText(user, review, "500000", sunday);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(allSent()).toContain("₦30,000");
      expect(allSent()).toContain("raise your limit properly");
    });

    it("measures the ceiling against the derived plan, not a previously raised limit", async () => {
      // Effective limit already raised to 30,000 this week, but the plan is
      // still 15,000 — so the ceiling must stay 30,000, not become 60,000.
      allowance.getOrCreateTodayAllowance.mockResolvedValue({
        amountAllocated: 30_000,
      });
      allowance.computePlannedDailyAmount.mockReturnValue(15_000);

      await service.handleLimitText(user, review, "45000", sunday);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("marks the review completed and records the chosen limit", async () => {
      await service.handleLimitText(user, review, "12000", sunday);

      expect(prisma.weeklyReview.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeeklyReviewStatus.COMPLETED,
            newDailyLimit: 12_000,
          }),
        }),
      );
    });
  });
});
