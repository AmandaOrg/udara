import {
  getWatHour,
  getWatDateParts,
  startOfWatDayInstant,
  watDateBucketKey,
  startOfWatIsoWeekBucketKey,
  startOfWatIsoWeekInstant,
  hoursUntilWatHour,
} from "./wat-time.util";

/**
 * Every fixture here is an explicit UTC instant (Date.UTC / a "Z" ISO
 * string), never the local Date constructor — the whole point of this
 * utility is to be correct regardless of the process's own timezone, so the
 * tests must not rely on the test runner's local timezone either (that's
 * exactly the gap that let the original bug ship unnoticed — see the
 * onboarding/allowance spec updates in the same change for more).
 */
describe("wat-time.util", () => {
  describe("getWatHour", () => {
    it("is 1 hour ahead of the UTC hour (WAT = UTC+1)", () => {
      expect(getWatHour(new Date("2026-01-08T10:00:00Z"))).toBe(11);
    });

    it("rolls over into the next WAT calendar day just before UTC midnight", () => {
      expect(getWatHour(new Date("2026-01-08T23:30:00Z"))).toBe(0); // 00:30 WAT, Jan 9
    });

    it("at exactly UTC 23:00 is WAT midnight", () => {
      expect(getWatHour(new Date("2026-01-08T23:00:00Z"))).toBe(0);
    });
  });

  describe("getWatDateParts", () => {
    it("returns the WAT calendar date for a straightforward daytime instant", () => {
      expect(getWatDateParts(new Date("2026-01-08T10:00:00Z"))).toEqual({
        year: 2026,
        month: 1,
        day: 8,
      });
    });

    it("rolls the calendar date forward for a late-UTC instant that's already tomorrow in WAT", () => {
      expect(getWatDateParts(new Date("2026-01-08T23:30:00Z"))).toEqual({
        year: 2026,
        month: 1,
        day: 9,
      });
    });
  });

  describe("startOfWatDayInstant", () => {
    it("is UTC 23:00 the previous day (the true instant of WAT midnight)", () => {
      const result = startOfWatDayInstant(new Date("2026-01-08T15:00:00Z"));
      expect(result.toISOString()).toBe("2026-01-07T23:00:00.000Z");
    });
  });

  describe("watDateBucketKey", () => {
    it("is UTC midnight of the WAT calendar date (a bucket key, not a real instant)", () => {
      const result = watDateBucketKey(new Date("2026-01-08T15:00:00Z"));
      expect(result.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    });

    it("uses the rolled-forward WAT date for a late-UTC instant", () => {
      const result = watDateBucketKey(new Date("2026-01-08T23:30:00Z"));
      expect(result.toISOString()).toBe("2026-01-09T00:00:00.000Z");
    });
  });

  describe("startOfWatIsoWeekBucketKey", () => {
    it("returns Monday's bucket key for a Thursday", () => {
      const thursday = new Date("2026-01-08T10:00:00Z");
      const result = startOfWatIsoWeekBucketKey(thursday);
      expect(result.toISOString()).toBe("2026-01-05T00:00:00.000Z"); // Monday
    });

    it("returns the same Monday for a Sunday (end of that ISO week)", () => {
      const sunday = new Date("2026-01-11T10:00:00Z");
      const result = startOfWatIsoWeekBucketKey(sunday);
      expect(result.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    });
  });

  describe("startOfWatIsoWeekInstant", () => {
    it("is the true instant of WAT midnight on that Monday", () => {
      const thursday = new Date("2026-01-08T10:00:00Z");
      const result = startOfWatIsoWeekInstant(thursday);
      expect(result.toISOString()).toBe("2026-01-04T23:00:00.000Z");
    });
  });

  describe("hoursUntilWatHour", () => {
    it("returns hours remaining today when before the target hour", () => {
      expect(hoursUntilWatHour(11, new Date("2026-01-08T07:00:00Z"))).toBe(3); // 08:00 WAT -> 11:00 WAT
    });

    it("returns 0 exactly at the target hour", () => {
      expect(hoursUntilWatHour(11, new Date("2026-01-08T10:00:00Z"))).toBe(0); // 11:00 WAT
    });

    it("returns hours until tomorrow once the target hour has passed today", () => {
      // 20:00 UTC = 21:00 WAT -> 24 - 21 + 11 = 14
      expect(hoursUntilWatHour(11, new Date("2026-01-08T20:00:00Z"))).toBe(14);
    });
  });
});
