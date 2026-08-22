import { Injectable } from "@nestjs/common";
import { getWatHour, hoursUntilWatHour } from "../common/wat-time.util";

/**
 * Deliberately dumb: a time-of-day comparison, nothing else.
 * Per PRD section 5 — "no AI needed for this part. Keep the core discipline
 * mechanism dumb and unbreakable rather than clever."
 *
 * windowStartHour/windowEndHour are WAT wall-clock hours (Udara's only
 * timezone) — always read via wat-time.util rather than Date's local
 * getters, which reflect the process's own timezone instead (see that
 * file's docblock for why that distinction matters in production).
 */
@Injectable()
export class WindowService {
  /**
   * @param now Injectable for testability — defaults to current time.
   */
  isWithinWindow(
    startHour: number,
    endHour: number,
    now: Date = new Date(),
  ): boolean {
    const hour = getWatHour(now);
    return hour >= startHour && hour < endHour;
  }

  hoursUntilWindowOpens(startHour: number, now: Date = new Date()): number {
    return hoursUntilWatHour(startHour, now);
  }
}
