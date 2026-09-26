import { ApiProperty } from "@nestjs/swagger";
import { RecipientLabel, TransactionType } from "@prisma/client";

const TRANSFER_STATUSES = [
  "awaiting_confirmation",
  "awaiting_pin",
  "processing",
  "successful",
  "failed",
  "cancelled",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

const CONFIRM_DECISIONS = [
  "pin_required",
  "requoted",
  "pin_setup_required",
  "insufficient_funds",
  "locked",
] as const;
export type ConfirmDecisionKind = (typeof CONFIRM_DECISIONS)[number];

const AUTHORIZE_RESULTS = [
  "successful",
  "processing",
  "failed",
  "wrong_pin",
  "locked",
  "cap_exceeded",
  "expired",
] as const;
export type AuthorizeResult = (typeof AUTHORIZE_RESULTS)[number];

export class TransferRecipientView {
  accountName!: string | null;
  nickname!: string | null;
  accountNumber!: string;
  bankCode!: string;
  /** From the bank list; null when that is unavailable. */
  bankName!: string | null;
}

export class TransferView {
  id!: string;
  @ApiProperty({ enum: TRANSFER_STATUSES })
  status!: TransferStatus;
  /** Naira. */
  amount!: number;
  /** Naira, on top of the amount. */
  fee!: number;
  @ApiProperty({ enum: TransactionType, enumName: "TransactionType" })
  spendType!: TransactionType;
  /** The line the WhatsApp card shows for a fee or a window, if any. */
  feeNote!: string | null;
  @ApiProperty({
    enum: RecipientLabel,
    enumName: "RecipientLabel",
    nullable: true,
  })
  purpose!: RecipientLabel | null;
  recipient!: TransferRecipientView;
  /** Where it was quoted: the app's send screen, or a conversation. */
  @ApiProperty({ enum: ["native", "chat"] })
  surface!: "native" | "chat";
  createdAt!: string;
  confirmedAt!: string | null;
  executedAt!: string | null;
}

export class QuoteView {
  transfer!: TransferView;
  isNewRecipient!: boolean;
  /**
   * Naira; null when the balance could not be read just now, and on a replay
   * of a transfer that has moved past its quote.
   */
  balanceAfter!: number | null;
  /** Naira left in today's allowance after this send; null as above. */
  allowanceLeftToday!: number | null;
}

export class RequoteView {
  @ApiProperty({ enum: ["stale", "terms_changed"] })
  reason!: "stale" | "terms_changed";
  balanceAfter!: number;
  allowanceLeftToday!: number;
}

export class ConfirmView {
  @ApiProperty({ enum: CONFIRM_DECISIONS })
  decision!: ConfirmDecisionKind;
  transfer!: TransferView;
  /** With `pin_required`: send it with the PIN to /authorize. */
  pinToken?: string;
  /** With `pin_required` for a user with no PIN: set one via /v1/forms/pin. */
  setupToken?: string;
  /** With `requoted`: the new terms, to show and confirm again. */
  requote?: RequoteView;
  /** With `insufficient_funds`: naira needed and naira held. */
  needed?: number;
  balance?: number;
  /** With `locked`: when PIN entry opens again. */
  lockedUntil?: string | null;
}

export class CapView {
  cap!: number;
  remaining!: number;
  liftsAt!: string;
}

export class AuthorizeView {
  @ApiProperty({ enum: AUTHORIZE_RESULTS })
  result!: AuthorizeResult;
  transfer!: TransferView;
  /** With `wrong_pin` and `locked`: what to tell the user. */
  message?: string;
  /** With `wrong_pin`: the token for the next attempt. */
  retryToken?: string;
  /** With `cap_exceeded`: the new-phone limit. */
  cap?: CapView;
}
