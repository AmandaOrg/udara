import { Logger } from "@nestjs/common";
import { SessionService } from "./session.service";
import { tokenDigest } from "./secret-hash.util";

describe("SessionService", () => {
  let prisma: {
    appSession: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    device: { update: jest.Mock };
    user: { update: jest.Mock };
  };
  let service: SessionService;
  const now = new Date("2026-09-25T12:00:00Z");
  const trustedDevice = {
    id: "device-1",
    trustedAt: new Date("2026-09-20T00:00:00Z"),
    revokedAt: null,
    lastSeenAt: now,
  };

  function liveSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "session-1",
      userId: "user-1",
      deviceId: "device-1",
      familyId: "family-1",
      accessExpiresAt: new Date(now.getTime() + 60_000),
      refreshExpiresAt: new Date(now.getTime() + 86_400_000),
      rotatedAt: null,
      revokedAt: null,
      device: trustedDevice,
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      appSession: {
        create: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      device: { update: jest.fn() },
      user: { update: jest.fn() },
    };
    service = new SessionService(
      prisma as any,
      { accessTtlMs: 15 * 60_000, refreshTtlMs: 30 * 86_400_000 } as any,
    );
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("issues tokens and stores only their digests", async () => {
    const tokens = await service.issue("user-1", "device-1", "family-1", now);

    const stored = prisma.appSession.create.mock.calls[0][0].data;
    expect(stored).toEqual({
      userId: "user-1",
      deviceId: "device-1",
      familyId: "family-1",
      accessHash: tokenDigest(tokens.accessToken),
      accessExpiresAt: new Date(now.getTime() + 15 * 60_000),
      refreshHash: tokenDigest(tokens.refreshToken),
      refreshExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    });
    expect(JSON.stringify(stored)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(stored)).not.toContain(tokens.refreshToken);
  });

  describe("authenticate", () => {
    it("returns the principal for a live access token", async () => {
      prisma.appSession.findUnique.mockResolvedValue(liveSession());

      expect(await service.authenticate("udr_at_x", now)).toEqual({
        userId: "user-1",
        deviceId: "device-1",
        sessionId: "session-1",
      });
      expect(prisma.appSession.findUnique).toHaveBeenCalledWith({
        where: { accessHash: tokenDigest("udr_at_x") },
        include: { device: true },
      });
    });

    it.each([
      ["unknown", null],
      ["expired", liveSession({ accessExpiresAt: now })],
      ["revoked", liveSession({ revokedAt: now })],
      ["rotated away", liveSession({ rotatedAt: now })],
      [
        "on a revoked device",
        liveSession({ device: { ...trustedDevice, revokedAt: now } }),
      ],
      [
        "on a device still owing step-up",
        liveSession({ device: { ...trustedDevice, trustedAt: null } }),
      ],
    ])("refuses a token that is %s", async (_why, session) => {
      prisma.appSession.findUnique.mockResolvedValue(session);

      expect(await service.authenticate("udr_at_x", now)).toBeNull();
    });

    /** lastInboundMessageAt means "a WhatsApp message arrived"; app use must not extend Meta's window. */
    it("stamps app activity on the user, never the WhatsApp inbound time", async () => {
      prisma.appSession.findUnique.mockResolvedValue(
        liveSession({ device: { ...trustedDevice, lastSeenAt: null } }),
      );

      await service.authenticate("udr_at_x", now);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { lastAppActiveAt: now },
      });
    });
  });

  describe("refresh", () => {
    it("retires the presented token and issues a successor in the same family", async () => {
      prisma.appSession.findUnique.mockResolvedValue(liveSession());

      const result = await service.refresh("udr_rt_x", now);

      expect(result.ok).toBe(true);
      expect(prisma.appSession.updateMany).toHaveBeenCalledWith({
        where: { id: "session-1", rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now },
      });
      expect(prisma.appSession.create.mock.calls[0][0].data.familyId).toBe(
        "family-1",
      );
    });

    /** Two holders of one refresh token means it was stolen: end both. */
    it("revokes the whole family when a retired token comes back later", async () => {
      prisma.appSession.findUnique.mockResolvedValue(
        liveSession({ rotatedAt: new Date(now.getTime() - 60_000) }),
      );

      expect(await service.refresh("udr_rt_x", now)).toEqual({
        ok: false,
        reason: "reused",
      });
      expect(prisma.appSession.updateMany).toHaveBeenCalledWith({
        where: { familyId: "family-1", revokedAt: null },
        data: { revokedAt: now },
      });
      expect(prisma.appSession.create).not.toHaveBeenCalled();
    });

    it("treats a second use within seconds as a client race, not theft", async () => {
      prisma.appSession.findUnique.mockResolvedValue(
        liveSession({ rotatedAt: new Date(now.getTime() - 5_000) }),
      );

      expect(await service.refresh("udr_rt_x", now)).toEqual({
        ok: false,
        reason: "in_progress",
      });
      expect(prisma.appSession.updateMany).not.toHaveBeenCalled();
    });

    it("gives the successor to only one of two parallel refreshes", async () => {
      prisma.appSession.findUnique.mockResolvedValue(liveSession());
      prisma.appSession.updateMany.mockResolvedValue({ count: 0 });

      expect(await service.refresh("udr_rt_x", now)).toEqual({
        ok: false,
        reason: "in_progress",
      });
      expect(prisma.appSession.create).not.toHaveBeenCalled();
    });

    it.each([
      ["unknown", null],
      ["revoked", liveSession({ revokedAt: now })],
      ["expired", liveSession({ refreshExpiresAt: now })],
      [
        "from a revoked device",
        liveSession({ device: { ...trustedDevice, revokedAt: now } }),
      ],
    ])("refuses a refresh token that is %s", async (_why, session) => {
      prisma.appSession.findUnique.mockResolvedValue(session);

      expect(await service.refresh("udr_rt_x", now)).toEqual({
        ok: false,
        reason: "invalid",
      });
    });
  });

  it("logs out the whole family, including rotated predecessors", async () => {
    prisma.appSession.findUnique.mockResolvedValue(liveSession());

    await service.logout(
      { userId: "user-1", deviceId: "device-1", sessionId: "session-1" },
      now,
    );

    expect(prisma.appSession.updateMany).toHaveBeenCalledWith({
      where: { familyId: "family-1", revokedAt: null },
      data: { revokedAt: now },
    });
  });
});
