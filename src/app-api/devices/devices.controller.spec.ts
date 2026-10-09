import { NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DevicePlatform } from "@prisma/client";
import { DevicesController } from "./devices.controller";
import { PushTokenDto } from "./devices.dto";

describe("DevicesController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };

  it("lists the caller's signed-in phones, marking the one in hand", async () => {
    const at = new Date("2026-10-01T08:00:00Z");
    const devices = {
      listSignedIn: jest.fn().mockResolvedValue([
        {
          id: "device-1",
          platform: DevicePlatform.IOS,
          name: "Ada's iPhone",
          trustedAt: at,
          lastSeenAt: at,
          createdAt: at,
        },
        {
          id: "device-2",
          platform: DevicePlatform.ANDROID,
          name: null,
          trustedAt: at,
          lastSeenAt: null,
          createdAt: at,
        },
      ]),
    };
    const controller = new DevicesController(devices as any);

    const view = await controller.list(principal);

    expect(devices.listSignedIn).toHaveBeenCalledWith("user-1");
    expect(view.devices).toEqual([
      {
        id: "device-1",
        platform: "ios",
        name: "Ada's iPhone",
        signedInAt: at.toISOString(),
        lastSeenAt: at.toISOString(),
        current: true,
      },
      {
        id: "device-2",
        platform: "android",
        name: null,
        signedInAt: at.toISOString(),
        lastSeenAt: null,
        current: false,
      },
    ]);
  });

  it("signs out only the caller's own phones, and is a 404 for anyone else's", async () => {
    const devices = { revoke: jest.fn().mockResolvedValueOnce(true) };
    const controller = new DevicesController(devices as any);

    await controller.revoke(principal, "device-2");
    expect(devices.revoke).toHaveBeenCalledWith("user-1", "device-2");

    devices.revoke.mockResolvedValueOnce(false);
    await expect(controller.revoke(principal, "device-9")).rejects.toThrow(
      NotFoundException,
    );
  });

  // Express matches in registration order: DELETE push-token must never be
  // read as DELETE :id (whose UUID pipe would answer 400).
  it("declares the push-token routes before :id", () => {
    const order = Object.getOwnPropertyNames(DevicesController.prototype);
    expect(order.indexOf("unregister")).toBeLessThan(order.indexOf("revoke"));
    expect(order.indexOf("register")).toBeLessThan(order.indexOf("revoke"));
  });

  it("only ever changes the caller's own device, from the session", async () => {
    const devices = {
      setPushToken: jest.fn().mockResolvedValue(undefined),
      clearPushToken: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new DevicesController(devices as any);

    await controller.register(principal, {
      pushToken: "ExponentPushToken[abc]",
    });
    await controller.unregister(principal);

    expect(devices.setPushToken).toHaveBeenCalledWith(
      "device-1",
      "ExponentPushToken[abc]",
    );
    expect(devices.clearPushToken).toHaveBeenCalledWith("device-1");
  });

  it.each([
    ["ExponentPushToken[xXx-123_abc]", true],
    ["ExpoPushToken[abc]", true],
    ["https://evil.example/hook", false],
    ["ExponentPushToken[]", false],
    ["ExponentPushToken[abc] trailing", false],
    [`ExponentPushToken[${"a".repeat(200)}]`, false],
  ])("accepts only Expo push tokens: %s", async (pushToken, ok) => {
    const errors = await validate(plainToInstance(PushTokenDto, { pushToken }));
    expect(errors.length === 0).toBe(ok);
  });
});
