import { WindowService } from "./window.service";

/**
 * Deliberately dumb time-of-day check — PRD: "no AI needed for this part. Keep
 * the core discipline mechanism dumb and unbreakable rather than clever."
 */
describe("WindowService", () => {
  let service: WindowService;

  beforeEach(() => {
    service = new WindowService();
  });

  describe("isWithinWindow", () => {
    const start = 11;
    const end = 20;

    it("is false right before the window opens (10:59)", () => {
      const now = new Date(2026, 0, 1, 10, 59);
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is true exactly at the opening hour (11:00)", () => {
      const now = new Date(2026, 0, 1, 11, 0);
      expect(service.isWithinWindow(start, end, now)).toBe(true);
    });

    it("is true mid-window (3:00 PM)", () => {
      const now = new Date(2026, 0, 1, 15, 0);
      expect(service.isWithinWindow(start, end, now)).toBe(true);
    });

    it("is false exactly at the closing hour (20:00) — end is exclusive", () => {
      const now = new Date(2026, 0, 1, 20, 0);
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is false after the window closes (20:01)", () => {
      const now = new Date(2026, 0, 1, 20, 1);
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("is false in the middle of the night (2 AM)", () => {
      const now = new Date(2026, 0, 1, 2, 0);
      expect(service.isWithinWindow(start, end, now)).toBe(false);
    });

    it("respects a custom, non-default window", () => {
      const now = new Date(2026, 0, 1, 8, 0);
      expect(service.isWithinWindow(7, 9, now)).toBe(true);
      expect(service.isWithinWindow(9, 11, now)).toBe(false);
    });
  });

  describe("hoursUntilWindowOpens", () => {
    it("returns hours remaining today when before the window", () => {
      const now = new Date(2026, 0, 1, 8, 0);
      expect(service.hoursUntilWindowOpens(11, now)).toBe(3);
    });

    it("returns hours until tomorrow when the window has already passed today", () => {
      const now = new Date(2026, 0, 1, 21, 0);
      expect(service.hoursUntilWindowOpens(11, now)).toBe(24 - 21 + 11);
    });

    it("returns 0 exactly at the opening hour", () => {
      const now = new Date(2026, 0, 1, 11, 0);
      expect(service.hoursUntilWindowOpens(11, now)).toBe(0);
    });
  });
});
