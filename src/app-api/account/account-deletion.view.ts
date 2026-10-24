import { ApiProperty } from "@nestjs/swagger";
import type { ClosureBlocker } from "../../account-closure/account-closure.service";
import { SettingsRequestView } from "../settings-requests/settings-requests.view";

export const CLOSURE_BLOCKERS = [
  "request_open",
  "payment_in_progress",
  "balance_unavailable",
  "balance_not_zero",
] as const satisfies readonly ClosureBlocker[];

export class AccountDeletionView {
  /** The open closure request, if there is one. */
  request!: SettingsRequestView | null;
  /** When the open request will have been carried out by. */
  completeBy!: string | null;
  canRequest!: boolean;
  @ApiProperty({ enum: CLOSURE_BLOCKERS, isArray: true })
  blockers!: ClosureBlocker[];
  /** Naira, live from the bank; null with no account, or if the bank did not answer. */
  balance!: number | null;
  /** Ask for the PIN before requesting. */
  pinRequired!: boolean;
  /** Whether records will be kept after closure (ADR-0003). */
  hasAccount!: boolean;
  /** What closing does and what is kept, to show before asking. */
  notice!: string;
}

export class AccountDeletionRequestedView {
  request!: SettingsRequestView;
  completeBy!: string;
}
