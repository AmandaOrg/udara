import { AppThrottlerGuard } from "./app-throttler.guard";

describe("AppThrottlerGuard", () => {
  const guard = Object.create(AppThrottlerGuard.prototype) as {
    getTracker(req: Record<string, unknown>): Promise<string>;
  };

  it("counts an app request against its session, not the shared carrier address", async () => {
    const a = await guard.getTracker({
      ip: "102.89.0.1",
      headers: { authorization: "Bearer udr_at_one" },
    });
    const b = await guard.getTracker({
      ip: "102.89.0.1",
      headers: { authorization: "Bearer udr_at_two" },
    });

    expect(a).toMatch(/^session:[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("udr_at_one");
  });

  it("falls back to the client address when there is no bearer token", async () => {
    expect(await guard.getTracker({ ip: "157.240.1.1", headers: {} })).toBe(
      "157.240.1.1",
    );
  });
});
