import { DeviceService } from "./device.service";

describe("DeviceService", () => {
  let prisma: {
    $transaction: jest.Mock;
    device: { updateMany: jest.Mock; update: jest.Mock };
  };
  let service: DeviceService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      device: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new DeviceService(prisma as any);
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
