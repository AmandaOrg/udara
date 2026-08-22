import { WindowService } from "./window.service";

/**
 * Deliberately dumb time-of-day check — PRD: "no AI needed for this part. Keep
 * the core discipline mechanism dumb and unbreakable rather than clever."
 *
 * Fixtures are explicit UTC instants (never the local Date constructor) and
 * comments give the equivalent WAT wall-clock time — this is what actually
 * exercises the WAT-anchoring (see wat-time.util.ts), and it makes the suite
 * pass identically regardless of the machine/CI's own timezone. Constructing
 * fixtures via the local Date constructor here would coincidentally pass on
 * a WAT-timezone dev machine even with the pre-fix bug reintroduced — that's
 * exactly how the original production bug shipped unnoticed.
 */
describe("WindowService", () => {
  let service: WindowService;

  beforeEach(() => {
    service = new WindowService();
  });

  describe("isWithinWindow", () => {
    const start = 11;
    const end = 20;

    it("is false right before the window opens (10:59 WAT)", () => {
      const now = new Date("2026-01-01T09:59:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is true exactly at the opening hour (11:00 WAT)", () => {
      const now = new Date("2026-01-01T10:00:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(true);
    });

    it("is true mid-window (3:00 PM WAT)", () => {
      const now = new Date("2026-01-01T14:00:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(true);
    });

    it("is false exactly at the closing hour (20:00 WAT) — end is exclusive", () => {
      const now = new Date("2026-01-01T19:00:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is false after the window closes (20:01 WAT)", () => {
      const now = new Date("2026-01-01T19:01:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is false in the middle of the night (2 AM WAT)", () => {
      const now = new Date("2026-01-01T01:00:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("respects a custom, non-default window", () => {
      const now = new Date("2026-01-01T07:00:00Z"); // 8:00 WAT
      expect(service.isWithinWindow(7, 9, now)).toBe(true);
      expect(service.isWithinWindow(9, 11, now)).toBe(false);
    });

    it("stays anchored to WAT even when the host process's own timezone is UTC (the shipped production bug)", () => {
      // 10:30 UTC is 11:30 WAT — inside the window. A process-local
      // getHours() read on a UTC-timezone host would see hour 10 and
      // wrongly report the window as still closed; this must not.
      const now = new Date("2026-01-01T10:30:00Z");
      expect(service.isWithinWindow(start, end, now)).toBe(true);
    });
  });

  describe("hoursUntilWindowOpens", () => {
    it("returns hours remaining today when before the window", () => {
      const now = new Date("2026-01-01T07:00:00Z"); // 8:00 WAT
      expect(service.hoursUntilWindowOpens(11, now)).toBe(3);
    });

    it("returns hours until tomorrow when the window has already passed today", () => {
      const now = new Date("2026-01-01T20:00:00Z"); // 21:00 WAT
      expect(service.hoursUntilWindowOpens(11, now)).toBe(24 - 21 + 11);
    });

    it("returns 0 exactly at the opening hour", () => {
      const now = new Date("2026-01-01T10:00:00Z"); // 11:00 WAT
      expect(service.hoursUntilWindowOpens(11, now)).toBe(0);
    });
  });
});
