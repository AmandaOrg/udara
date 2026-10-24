import {
  NewDeviceCapService,
  NEW_DEVICE_WINDOW_MS,
} from "./new-device-cap.service";

describe("NewDeviceCapService", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const trustedAt = new Date(now.getTime() - 2 * 3_600_000);
  let prisma: {
    device: { findFirst: jest.Mock };
    transaction: { aggregate: jest.Mock };
    billPayment: { aggregate: jest.Mock };
  };
  let service: NewDeviceCapService;

  const sent = (transfers: number, bills: number) => {
    prisma.transaction.aggregate.mockResolvedValue({
      _sum: { amount: transfers },
    });
    prisma.billPayment.aggregate.mockResolvedValue({ _sum: { amount: bills } });
  };

  beforeEach(() => {
    prisma = {
      device: { findFirst: jest.fn().mockResolvedValue({ trustedAt }) },
      transaction: { aggregate: jest.fn() },
      billPayment: { aggregate: jest.fn() },
    };
    sent(0, 0);
    service = new NewDeviceCapService(
      prisma as any,
      {
        newDeviceTransferCap: 20_000,
      } as any,
    );
  });

  it("allows up to the cap exactly on a new device", async () => {
    sent(5_000, 0);

    await expect(
      service.check("user-1", "device-1", 15_000, now),
    ).resolves.toEqual({ ok: true });
  });

  it("refuses the first naira over it, counting transfers and bills together", async () => {
    sent(4_000, 1_000);

    await expect(
      service.check("user-1", "device-1", 15_001, now),
    ).resolves.toEqual({
      ok: false,
      cap: 20_000,
      remaining: 15_000,
      liftsAt: new Date(trustedAt.getTime() + NEW_DEVICE_WINDOW_MS),
    });
  });

  /**
   * Everything sent since the device was trusted, from any channel, and only
   * money that moved or is moving: a cancelled or failed payment used nothing.
   */
  it("counts confirmed and executed payments since the device was trusted", async () => {
    await service.check("user-1", "device-1", 100, now);

    const where = {
      userId: "user-1",
      status: { in: ["CONFIRMED", "EXECUTED"] },
      confirmedAt: { gte: trustedAt },
    };
    expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
      where,
      _sum: { amount: true },
    });
    expect(prisma.billPayment.aggregate).toHaveBeenCalledWith({
      where,
      _sum: { amount: true },
    });
  });

  it("never reports less than nothing remaining", async () => {
    sent(25_000, 0);

    const verdict = await service.check("user-1", "device-1", 1, now);

    expect(verdict).toMatchObject({ ok: false, remaining: 0 });
  });

  it("lifts once the device has been trusted for 24 hours", async () => {
    prisma.device.findFirst.mockResolvedValue({
      trustedAt: new Date(now.getTime() - NEW_DEVICE_WINDOW_MS),
    });

    await expect(
      service.check("user-1", "device-1", 1_000_000, now),
    ).resolves.toEqual({ ok: true });
    expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
  });

  it("looks the device up under the user, and refuses one that is not theirs or not trusted", async () => {
    prisma.device.findFirst.mockResolvedValue(null);

    const verdict = await service.check("user-1", "device-x", 1, now);

    expect(prisma.device.findFirst).toHaveBeenCalledWith({
      where: { id: "device-x", userId: "user-1" },
    });
    expect(verdict).toMatchObject({ ok: false, remaining: 0 });
  });
});
