import { ApiProperty } from "@nestjs/swagger";

/**
 * The vocabulary the app's native money screens share, transfers (P7) and
 * bills (P8) alike, so the app handles both with one set of states.
 */
export const PAYMENT_STATUSES = [
  "awaiting_confirmation",
  "awaiting_pin",
  "processing",
  "successful",
  "failed",
  "cancelled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CONFIRM_DECISIONS = [
  "pin_required",
  "requoted",
  "pin_setup_required",
  "insufficient_funds",
  "locked",
] as const;
export type ConfirmDecisionKind = (typeof CONFIRM_DECISIONS)[number];

export const AUTHORIZE_RESULTS = [
  "successful",
  "processing",
  "failed",
  "wrong_pin",
  "locked",
  "cap_exceeded",
  "expired",
] as const;
export type AuthorizeResult = (typeof AUTHORIZE_RESULTS)[number];

export class RequoteView {
  @ApiProperty({ enum: ["stale", "terms_changed"] })
  reason!: "stale" | "terms_changed";
  balanceAfter!: number;
  allowanceLeftToday!: number;
}

export class CapView {
  cap!: number;
  remaining!: number;
  liftsAt!: string;
}
