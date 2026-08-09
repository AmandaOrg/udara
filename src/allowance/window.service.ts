import { Injectable } from '@nestjs/common';

/**
 * Deliberately dumb: a time-of-day comparison, nothing else.
 * Per PRD section 5 — "no AI needed for this part. Keep the core discipline
 * mechanism dumb and unbreakable rather than clever."
 */
@Injectable()
export class WindowService {
  /**
   * @param now Injectable for testability — defaults to current time.
   */
  isWithinWindow(startHour: number, endHour: number, now: Date = new Date()): boolean {
    const hour = now.getHours();
    return hour >= startHour && hour < endHour;
  }

  hoursUntilWindowOpens(startHour: number, now: Date = new Date()): number {
    const hour = now.getHours();
    if (hour < startHour) return startHour - hour;
    // window already passed today — opens tomorrow
    return 24 - hour + startHour;
  }
}
