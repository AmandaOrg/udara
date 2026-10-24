import { describeLimits } from "./limits-status";

describe("describeLimits", () => {
  const now = new Date("2026-09-26T09:00:00Z");
  const remaining = { remainingToday: 2_000, remainingWeek: 12_000 };
  const user = {
    disciplineExitedAt: null,
    windowStartHour: 11,
    windowEndHour: 20,
  };

  function windowService(open: boolean) {
    return {
      isWithinWindow: jest.fn().mockReturnValue(open),
      hoursUntilWindowOpens: jest.fn().mockReturnValue(3),
    };
  }

  it("reports an open window with no wait", () => {
    const ws = windowService(true);
    expect(describeLimits(user, remaining, ws, now)).toEqual({
      remainingToday: 2_000,
      remainingWeek: 12_000,
      restrictionsOff: false,
      window: { startHour: 11, endHour: 20, open: true, opensInHours: null },
    });
    expect(ws.isWithinWindow).toHaveBeenCalledWith(11, 20, now);
  });

  it("reports a closed window and how long until it opens", () => {
    const ws = windowService(false);
    expect(describeLimits(user, remaining, ws, now).window).toEqual({
      startHour: 11,
      endHour: 20,
      open: false,
      opensInHours: 3,
    });
    expect(ws.hoursUntilWindowOpens).toHaveBeenCalledWith(11, now);
  });

  it("treats the window as open, without asking, once restrictions are off", () => {
    const ws = windowService(false);
    const status = describeLimits(
      { ...user, disciplineExitedAt: new Date("2026-09-01T00:00:00Z") },
      remaining,
      ws,
      now,
    );
    expect(status.restrictionsOff).toBe(true);
    expect(status.window.open).toBe(true);
    expect(status.window.opensInHours).toBeNull();
    expect(ws.isWithinWindow).not.toHaveBeenCalled();
  });
});
