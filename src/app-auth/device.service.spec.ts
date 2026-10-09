import { DeviceService } from "./device.service";

describe("DeviceService", () => {
  let prisma: {
    $transaction: jest.Mock;
    device: { updateMany: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    appSession: { updateMany: jest.Mock };
  };
  let service: DeviceService;
  const now = new Date("2026-10-09T12:00:00Z");

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      device: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      appSession: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    service = new DeviceService(prisma as any);
  });

  it("lists only the caller's phones that are still signed in", async () => {
    await service.listSignedIn("user-1", now);

    expect(prisma.device.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        trustedAt: { not: null },
        revokedAt: null,
        sessions: {
          some: { revokedAt: null, refreshExpiresAt: { gt: now } },
        },
      },
      orderBy: { trustedAt: "desc" },
    });
  });

  it("signs a phone out in one step: the device, its push token and its sessions", async () => {
    prisma.device.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.revoke("user-1", "device-2", now)).resolves.toBe(true);

    expect(prisma.device.updateMany).toHaveBeenCalledWith({
      where: { id: "device-2", userId: "user-1", revokedAt: null },
      data: { revokedAt: now, pushToken: null },
    });
    expect(prisma.appSession.updateMany).toHaveBeenCalledWith({
      where: { deviceId: "device-2", userId: "user-1", revokedAt: null },
      data: { revokedAt: now },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("touches nothing of anyone else's, and says so", async () => {
    await expect(service.revoke("user-2", "device-2", now)).resolves.toBe(
      false,
    );

    // Both writes are scoped to the caller, so they match nothing.
    expect(prisma.appSession.updateMany.mock.calls[0][0].where.userId).toBe(
      "user-2",
    );
  });

  /**
   * A phone signed in as someone new, or passed on, keeps its Expo token. The
   * old account's alerts must stop reaching it.
   */
  it("takes the token off every other device before giving it to this one", async () => {
    await service.setPushToken("device-2", "ExponentPushToken[abc]");

    expect(prisma.device.updateMany).toHaveBeenCalledWith({
      where: { pushToken: "ExponentPushToken[abc]", id: { not: "device-2" } },
      data: { pushToken: null },
    });
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "device-2" },
      data: { pushToken: "ExponentPushToken[abc]" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("clears the caller's own token", async () => {
    await service.clearPushToken("device-2");

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "device-2" },
      data: { pushToken: null },
    });
  });
});
