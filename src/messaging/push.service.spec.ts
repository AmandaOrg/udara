import { Logger } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { PushService, PUSH_BODY, PUSH_COOLDOWN_MS } from "./push.service";

describe("PushService", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const token = "ExponentPushToken[abc123]";
  let prisma: { device: { findMany: jest.Mock; updateMany: jest.Mock } };
  let http: { post: jest.Mock };
  let config: Record<string, string | undefined>;
  let service: PushService;

  beforeEach(() => {
    prisma = {
      device: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "device-1", pushToken: token }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    http = {
      post: jest
        .fn()
        .mockReturnValue(of({ data: { data: [{ status: "ok" }] } })),
    };
    config = {};
    service = new PushService(
      prisma as any,
      http as any,
      {
        get: (key: string) => config[key],
      } as any,
    );
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it("sends a generic alert that opens the chat", async () => {
    await service.notify("user-1", "transactional", now);

    const [url, messages] = http.post.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(messages).toEqual([
      {
        to: token,
        title: "Udara",
        body: PUSH_BODY.transactional,
        sound: "default",
        data: { screen: "chat" },
      },
    ]);
  });

  /** A lock screen is readable by whoever holds the phone. */
  it("never says an amount, a name or an account number", () => {
    for (const body of Object.values(PUSH_BODY)) {
      expect(body).not.toMatch(/₦|\d/);
    }
  });

  it("only looks at signed-in devices with a token", async () => {
    await service.notify("user-1", "proactive", now);

    expect(prisma.device.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        revokedAt: null,
        pushToken: { not: null },
        sessions: { some: { revokedAt: null, refreshExpiresAt: { gt: now } } },
      },
      select: { id: true, pushToken: true },
    });
  });

  it("sends one alert per device per minute, however many messages there are", async () => {
    prisma.device.updateMany.mockResolvedValue({ count: 0 });

    await service.notify("user-1", "proactive", now);

    expect(prisma.device.updateMany).toHaveBeenCalledWith({
      where: {
        id: "device-1",
        OR: [
          { lastPushAt: null },
          { lastPushAt: { lt: new Date(now.getTime() - PUSH_COOLDOWN_MS) } },
        ],
      },
      data: { lastPushAt: now },
    });
    expect(http.post).not.toHaveBeenCalled();
  });

  it("forgets a token Expo says is no longer registered", async () => {
    http.post.mockReturnValue(
      of({
        data: {
          data: [
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        },
      }),
    );

    await service.notify("user-1", "proactive", now);

    expect(prisma.device.updateMany).toHaveBeenLastCalledWith({
      where: { id: "device-1", pushToken: token },
      data: { pushToken: null },
    });
  });

  it("sends nothing in dry run, but still claims the cooldown", async () => {
    config.PUSH_DRY_RUN = "true";

    await service.notify("user-1", "proactive", now);

    expect(http.post).not.toHaveBeenCalled();
    expect(prisma.device.updateMany).toHaveBeenCalled();
  });

  it("uses the Expo access token when one is configured", async () => {
    config.EXPO_ACCESS_TOKEN = "expo-secret";

    await service.notify("user-1", "proactive", now);

    expect(http.post.mock.calls[0][2].headers.Authorization).toBe(
      "Bearer expo-secret",
    );
  });

  /** The message is already in the app; a push failure must not undo a send. */
  it("never throws, and never logs the token", async () => {
    http.post.mockReturnValue(throwError(() => new Error("network down")));

    await expect(
      service.notify("user-1", "proactive", now),
    ).resolves.toBeUndefined();
    const logged = (Logger.prototype.warn as jest.Mock).mock.calls.flat();
    expect(logged.join(" ")).not.toContain("abc123");
  });
});
