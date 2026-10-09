import { ApiProperty } from "@nestjs/swagger";
import { TransactionType } from "@prisma/client";
import { BillPaymentCategory } from "../../prisma/bill-payment.enums";
import {
  AUTHORIZE_RESULTS,
  AuthorizeResult,
  CapView,
  CONFIRM_DECISIONS,
  ConfirmDecisionKind,
  PAYMENT_STATUSES,
  PaymentStatus,
  RequoteView,
} from "../payment.view";
import { BILL_CATEGORIES } from "./bills.dto";

export class BillPaymentView {
  id!: string;
  @ApiProperty({ enum: PAYMENT_STATUSES })
  status!: PaymentStatus;
  @ApiProperty({ enum: BILL_CATEGORIES, enumName: "BillPaymentCategory" })
  category!: BillPaymentCategory;
  /** The network, or the electricity company. */
  provider!: string;
  /** The data bundle, or "Prepaid electricity"; null for airtime. */
  product!: string | null;
  /** The phone number or meter number. */
  target!: string;
  /** The name on the meter, as the electricity company holds it. */
  customerName!: string | null;
  /** Naira. */
  amount!: number;
  /** Naira, on top of the amount. */
  fee!: number;
  @ApiProperty({ enum: TransactionType, enumName: "TransactionType" })
  spendType!: TransactionType;
  /** The line the WhatsApp card shows for a fee or a window, if any. */
  feeNote!: string | null;
  /** The electricity token, once the purchase has gone through. */
  token!: string | null;
  /** Where it was quoted: the app's bill screen, or a conversation. */
  @ApiProperty({ enum: ["native", "chat"] })
  surface!: "native" | "chat";
  createdAt!: string;
  confirmedAt!: string | null;
  executedAt!: string | null;
}

export class BillQuoteView {
  payment!: BillPaymentView;
  /**
   * Naira; null when the balance could not be read just now, and on a replay
   * of a purchase that has moved past its quote.
   */
  balanceAfter!: number | null;
  /** Naira left in today's allowance after this purchase; null as above. */
  allowanceLeftToday!: number | null;
}

export class BillConfirmView {
  @ApiProperty({ enum: CONFIRM_DECISIONS })
  decision!: ConfirmDecisionKind;
  payment!: BillPaymentView;
  /** With `pin_required`: send it with the PIN to /authorize. */
  pinToken?: string;
  /** With `pin_setup_required`: set a PIN via /v1/forms/pin, then confirm again. */
  setupToken?: string;
  /** With `requoted`: the new terms, to show and confirm again. */
  requote?: RequoteView;
  /** With `insufficient_funds`: naira needed and naira held. */
  needed?: number;
  balance?: number;
  /** With `locked`: when PIN entry opens again. */
  lockedUntil?: string | null;
}

export class BillAuthorizeView {
  @ApiProperty({ enum: AUTHORIZE_RESULTS })
  result!: AuthorizeResult;
  payment!: BillPaymentView;
  /** With `wrong_pin` and `locked`: what to tell the user. */
  message?: string;
  /** With `wrong_pin`: the token for the next attempt. */
  retryToken?: string;
  /** With `cap_exceeded`: the new-phone limit. */
  cap?: CapView;
}
