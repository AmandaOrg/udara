import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";

/**
 * Wakes a user's waiting long-polls when a row is written for them.
 *
 * In-process only. With more than one replica, a row written by another
 * replica is found by the poll's own periodic re-check instead, a couple of
 * seconds later; this just makes the common single-replica case immediate
 * without hammering the database.
 */
@Injectable()
export class AppMessageNotifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open long-poll; the default cap of 10 is a leak
    // heuristic that does not fit that.
    this.emitter.setMaxListeners(0);
  }

  notify(userId: string): void {
    this.emitter.emit(userId);
  }

  /** True if notified before `ms` elapsed, false on timeout. */
  wait(userId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onNotify = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.emitter.off(userId, onNotify);
        resolve(false);
      }, ms);
      this.emitter.once(userId, onNotify);
    });
  }
}
