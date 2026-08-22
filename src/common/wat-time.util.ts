/**
 * Udara operates in one timezone only: Africa/Lagos ("WAT", UTC+1, no DST,
 * fixed year-round). windowStartHour/windowEndHour (User model), the
 * spending-window copy sent during onboarding ("opens 11am, closes 8pm"),
 * and the daily/weekly allowance rollover are all specified in WAT wall-clock
 * terms, not "whatever timezone the Node process happens to be running in."
 *
 * Every function here is deliberately anchored to Africa/Lagos via
 * Intl.DateTimeFormat's explicit `timeZone` option, never the ambient
 * process/system timezone (`Date.prototype.getHours()` and friends read the
 * *process's* local timezone, which is Africa/Lagos on a dev machine set to
 * WAT but is NOT guaranteed to be on a deployment host — Railway's default
 * container timezone is UTC unless explicitly configured, and nothing in
 * this repo sets TZ). Route every "what hour/day is it right now" check in
 * the allowance/window/nudge code through here instead of reaching for
 * Date's local getters directly, so behavior is identical regardless of the
 * host's timezone.
 */

const WAT_TIME_ZONE = "Africa/Lagos";

/** The wall-clock hour (0-23) in WAT for a given instant. */
export function getWatHour(date: Date): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: WAT_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  // hourCycle h23 should already yield 00-23, but normalize a stray "24"
  // defensively (some ICU implementations have emitted this for hourCycle
  // edge cases historically) rather than trust it blindly.
  const hour = Number(formatted);
  return hour === 24 ? 0 : hour;
}

export interface WatDateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/** The WAT calendar date (year/month/day) a given instant falls on. */
export function getWatDateParts(date: Date): WatDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WAT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
}

/**
 * The true UTC instant of WAT midnight (00:00 WAT) for the given WAT
 * calendar date. WAT is a fixed UTC+1, so WAT midnight is always UTC 23:00
 * the previous day.
 */
function watMidnightInstant({ year, month, day }: WatDateParts): Date {
  return new Date(Date.UTC(year, month - 1, day, -1, 0, 0));
}

/**
 * The true UTC instant of WAT midnight (00:00 WAT) for the WAT calendar day
 * a given instant falls on — use this for real DateTime comparisons (e.g.
 * "has anything been sent since the start of today, WAT").
 */
export function startOfWatDayInstant(date: Date): Date {
  return watMidnightInstant(getWatDateParts(date));
}

/**
 * A "bucket key" Date for the WAT calendar day a given instant falls on —
 * NOT a real instant. Its UTC year/month/day equal the WAT calendar date,
 * which is deliberately what Prisma's `@db.Date` columns need: Prisma
 * serializes `@db.Date` fields via the Date object's UTC calendar
 * components, so a "true" WAT-midnight instant (UTC 23:00 the prior day)
 * would round-trip through Prisma as the *wrong* day. Use this — not
 * startOfWatDayInstant — for any value written to or compared against a
 * `@db.Date` column (DailyAllowance.date/weekStartDate).
 */
export function watDateBucketKey(date: Date): Date {
  const { year, month, day } = getWatDateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Monday of the WAT ISO week a given instant falls on, as WatDateParts. */
function watIsoWeekStartParts(date: Date): WatDateParts {
  const bucketKey = watDateBucketKey(date);
  const day = bucketKey.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  const monday = new Date(bucketKey);
  monday.setUTCDate(monday.getUTCDate() + diff);
  return {
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
  };
}

/**
 * Monday of the WAT ISO week a given instant falls on, as a bucket key (see
 * watDateBucketKey — same UTC-midnight convention, for `@db.Date` columns).
 */
export function startOfWatIsoWeekBucketKey(date: Date): Date {
  const { year, month, day } = watIsoWeekStartParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Monday of the WAT ISO week a given instant falls on, as the true UTC
 * instant of that Monday's WAT midnight — use this for real DateTime range
 * comparisons (e.g. "transactions since the start of this week").
 */
export function startOfWatIsoWeekInstant(date: Date): Date {
  return watMidnightInstant(watIsoWeekStartParts(date));
}

/**
 * Hours remaining until the next WAT wall-clock occurrence of targetHour.
 * `<=`, not `<`: at the target hour itself, 0 hours remain (already open),
 * matching WindowService.isWithinWindow's `hour >= startHour`.
 */
export function hoursUntilWatHour(targetHour: number, date: Date): number {
  const hour = getWatHour(date);
  if (hour <= targetHour) return targetHour - hour;
  return 24 - hour + targetHour;
}
