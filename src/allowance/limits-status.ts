import type { User } from "@prisma/client";
import type { WindowService } from "./window.service";

export interface LimitsStatus {
  remainingToday: number;
  remainingWeek: number;
  /** An approved exit: no window and no override fees (disciplineExitedAt). */
  restrictionsOff: boolean;
  window: {
    startHour: number;
    endHour: number;
    open: boolean;
    /** Null while the window is open, or when restrictions are off. */
    opensInHours: number | null;
  };
}

/**
 * What the "Limits" reply on WhatsApp and GET /v1/limits both report, from
 * one place, so the chat and the app's screen can never describe the same
 * moment differently. The remaining figures come from
 * AllowanceService.getRemainingSummary.
 */
export function describeLimits(
  user: Pick<User, "disciplineExitedAt" | "windowStartHour" | "windowEndHour">,
  remaining: { remainingToday: number; remainingWeek: number },
  windowService: Pick<
    WindowService,
    "isWithinWindow" | "hoursUntilWindowOpens"
  >,
  now: Date = new Date(),
): LimitsStatus {
  const restrictionsOff = Boolean(user.disciplineExitedAt);
  const open =
    restrictionsOff ||
    windowService.isWithinWindow(user.windowStartHour, user.windowEndHour, now);
  return {
    remainingToday: remaining.remainingToday,
    remainingWeek: remaining.remainingWeek,
    restrictionsOff,
    window: {
      startHour: user.windowStartHour,
      endHour: user.windowEndHour,
      open,
      opensInHours: open
        ? null
        : windowService.hoursUntilWindowOpens(user.windowStartHour, now),
    },
  };
}
