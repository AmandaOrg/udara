import { AppConfigController } from "./app-config.controller";

describe("AppConfigController", () => {
  it.each([
    ["1.4.0", "1.4.0"],
    ["", null],
    [undefined, null],
  ])("reports the minimum version %p as %p", (value, expected) => {
    const config = { get: jest.fn().mockReturnValue(value) };
    const controller = new AppConfigController(config as any);
    expect(controller.get()).toEqual({ minSupportedVersion: expected });
  });
});
