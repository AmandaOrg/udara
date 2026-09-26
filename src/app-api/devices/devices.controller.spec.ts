import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DevicesController } from "./devices.controller";
import { PushTokenDto } from "./devices.dto";

describe("DevicesController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };

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
