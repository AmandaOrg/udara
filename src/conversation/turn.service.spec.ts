import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TurnService, TURN_WAIT_MS } from "./turn.service";

class InstantTurnService extends TurnService {
  slept = 0;
  protected override async sleep(ms: number): Promise<void> {
    this.slept += ms;
    jest.setSystemTime(Date.now() + ms);
  }
}

const busy = () =>
  new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "5",
  });

describe("TurnService", () => {
  const user = { id: "user-1", onboardingStage: "COMPLETE" };
  let prisma: {
    userTurnLease: {
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    user: { findUniqueOrThrow: jest.Mock };
    transferDraft: { updateMany: jest.Mock };
    billPaymentDraft: { updateMany: jest.Mock };
    weeklyReview: { updateMany: jest.Mock };
    conversationSession: { findFirst: jest.Mock; update: jest.Mock };
  };
  let service: InstantTurnService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-26T10:00:00Z") });
    prisma = {
      userTurnLease: {
        // Free and previously used on WhatsApp, unless a test says otherwise.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ lastChannel: "WHATSAPP" }),
        create: jest.fn().mockResolvedValue({}),
      },
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user) },
      transferDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      billPaymentDraft: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      weeklyReview: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      conversationSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    service = new InstantTurnService(prisma as any);
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const claims = () =>
    prisma.userTurnLease.updateMany.mock.calls.filter(
      ([args]) => args.data.holder !== undefined,
    );
  const releases = () =>
    prisma.userTurnLease.updateMany.mock.calls.filter(
      ([args]) => args.data.expiresAt?.getTime() === 0,
    );

  it("runs the turn with the user as read after the lease is held", async () => {
    const fn = jest.fn().mockResolvedValue("done");

    await expect(service.run("user-1", "whatsapp", fn)).resolves.toBe("done");

    expect(fn).toHaveBeenCalledWith(user);
    const [claim] = claims()[0];
    expect(claim.where).toEqual({
      userId: "user-1",
      expiresAt: { lte: expect.any(Date) },
    });
    expect(releases()).toHaveLength(1);
    expect(releases()[0][0].where).toEqual({
      userId: "user-1",
      holder: claim.data.holder,
    });
  });

  it("creates the lease row on a user's first turn", async () => {
    prisma.userTurnLease.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.run("user-1", "whatsapp", async () => undefined);

    expect(prisma.userTurnLease.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        holder: expect.any(String),
        expiresAt: expect.any(Date),
      },
    });
  });

  it("waits while another turn holds the lease, then runs", async () => {
    prisma.userTurnLease.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    prisma.userTurnLease.create.mockRejectedValue(busy());
    const fn = jest.fn().mockResolvedValue(undefined);

    await service.run("user-1", "whatsapp", fn);

    expect(service.slept).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  /** A hung turn must not mean this message is never answered. */
  it("runs anyway, without the lease, once the wait runs out", async () => {
    prisma.userTurnLease.updateMany.mockResolvedValue({ count: 0 });
    prisma.userTurnLease.create.mockRejectedValue(busy());
    const fn = jest.fn().mockResolvedValue(undefined);

    await service.run("user-1", "app", fn);

    expect(service.slept).toBeGreaterThanOrEqual(TURN_WAIT_MS - 200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("running this turn without it"),
    );
    // Not ours to release, and no channel bookkeeping without it.
    expect(releases()).toHaveLength(0);
    expect(prisma.transferDraft.updateMany).not.toHaveBeenCalled();
  });

  it("releases the lease when the turn throws, and keeps the turn's own error", async () => {
    await expect(
      service.run("user-1", "whatsapp", async () => {
        throw new Error("rubies timed out");
      }),
    ).rejects.toThrow("rubies timed out");

    expect(releases()).toHaveLength(1);
  });

  it("lets an unexpected database error through rather than spinning", async () => {
    prisma.userTurnLease.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.userTurnLease.create.mockRejectedValue(new Error("db down"));

    await expect(
      service.run("user-1", "whatsapp", async () => undefined),
    ).rejects.toThrow("db down");
  });

  describe("changing channel", () => {
    it("leaves everything open when the user stays on the same channel", async () => {
      await service.run("user-1", "whatsapp", async () => undefined);

      expect(prisma.transferDraft.updateMany).not.toHaveBeenCalled();
      expect(prisma.billPaymentDraft.updateMany).not.toHaveBeenCalled();
      expect(prisma.weeklyReview.updateMany).not.toHaveBeenCalled();
    });

    /**
     * A transfer wizard opened on WhatsApp and waiting for an amount would
     * otherwise read the next number typed in the app as that amount.
     */
    it("expires wizards and waits left open on the other channel, before the turn runs", async () => {
      const order: string[] = [];
      prisma.transferDraft.updateMany.mockImplementation(async () => {
        order.push("expire");
        return { count: 1 };
      });
      prisma.conversationSession.findFirst.mockResolvedValue({
        id: "s1",
        contextData: { beneficiaryPick: { amount: 5000 }, lastIntent: "x" },
      });

      await service.run("user-1", "app", async () => {
        order.push("turn");
      });

      expect(order).toEqual(["expire", "turn"]);
      expect(prisma.transferDraft.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      expect(prisma.billPaymentDraft.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      expect(prisma.weeklyReview.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", status: "AWAITING_LIMIT" },
        data: { status: "COMPLETED", respondedAt: expect.any(Date) },
      });
      expect(prisma.conversationSession.update).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { contextData: { lastIntent: "x" } },
      });
      // And remembers the new channel, under this turn's lease only.
      const recorded = prisma.userTurnLease.updateMany.mock.calls.find(
        ([args]) => args.data.lastChannel,
      );
      expect(recorded?.[0]).toEqual({
        where: { userId: "user-1", holder: expect.any(String) },
        data: { lastChannel: "APP" },
      });
    });

    it("treats a user with no recorded channel as coming from WhatsApp, where everyone was before", async () => {
      prisma.userTurnLease.findUnique.mockResolvedValue({ lastChannel: null });

      await service.run("user-1", "app", async () => undefined);

      expect(prisma.transferDraft.updateMany).toHaveBeenCalled();
    });

    it("does not expire anything on a first WhatsApp turn", async () => {
      prisma.userTurnLease.updateMany.mockResolvedValueOnce({ count: 0 });

      await service.run("user-1", "whatsapp", async () => undefined);

      expect(prisma.transferDraft.updateMany).not.toHaveBeenCalled();
    });

    it("expires app wizards when the user goes back to WhatsApp", async () => {
      prisma.userTurnLease.findUnique.mockResolvedValue({ lastChannel: "APP" });

      await service.run("user-1", "whatsapp", async () => undefined);

      expect(prisma.transferDraft.updateMany).toHaveBeenCalled();
    });
  });
});
