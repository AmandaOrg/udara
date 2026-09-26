import { ApiProperty } from "@nestjs/swagger";
import {
  BillPaymentCategory,
  RecipientLabel,
  TransactionType,
} from "@prisma/client";

// Unions and Prisma enums are types only, which the OpenAPI plugin cannot
// see; @ApiProperty names their values so a generated client gets them.
const HISTORY_KINDS = ["transfer", "bill", "credit"] as const;
const HISTORY_STATUSES = ["processing", "successful", "failed"] as const;

export type HistoryKind = (typeof HISTORY_KINDS)[number];
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export class TransferDetailView {
  accountName!: string | null;
  nickname!: string | null;
  accountNumber!: string;
  bankCode!: string;
  /** From the bank list; null when that is unavailable. */
  bankName!: string | null;
  @ApiProperty({
    enum: RecipientLabel,
    enumName: "RecipientLabel",
    nullable: true,
  })
  purpose!: RecipientLabel | null;
}

export class BillDetailView {
  @ApiProperty({ enum: BillPaymentCategory, enumName: "BillPaymentCategory" })
  category!: BillPaymentCategory;
  /** The network, or the electricity company. */
  provider!: string;
  /** The data bundle, when there is one. */
  product!: string | null;
  /** The phone number or meter number. */
  target!: string;
  /** The name on the meter, for electricity. */
  customerName!: string | null;
  /** The electricity token, once bought. */
  token!: string | null;
}

export class CreditDetailView {
  narration!: string | null;
}

export class HistoryItemView {
  id!: string;
  @ApiProperty({ enum: HISTORY_KINDS })
  kind!: HistoryKind;
  @ApiProperty({ enum: ["in", "out"] })
  direction!: "in" | "out";
  @ApiProperty({ enum: HISTORY_STATUSES })
  status!: HistoryStatus;
  /** Naira. */
  amount!: number;
  /** Naira; the window or borrowing fee on top of the amount. */
  fee!: number;
  /** Null for money received. */
  @ApiProperty({
    enum: TransactionType,
    enumName: "TransactionType",
    nullable: true,
  })
  spendType!: TransactionType | null;
  occurredAt!: string;
  /** A line to show: the recipient, the purchase, or the sender's narration. */
  title!: string;
  transfer?: TransferDetailView;
  bill?: BillDetailView;
  credit?: CreditDetailView;
}

export class HistoryPageView {
  /** Newest first. */
  items!: HistoryItemView[];
  /** Pass back as `cursor` for the next page; null at the end. */
  nextCursor!: string | null;
}

export class SpendByDayView {
  /** WAT date, YYYY-MM-DD. */
  date!: string;
  amount!: number;
}

export class SpendSummaryView {
  @ApiProperty({ enum: ["week", "month"] })
  period!: "week" | "month";
  periodStart!: string;
  totalSpent!: number;
  transactionCount!: number;
  byDay!: SpendByDayView[];
  /** Naira per recipient label; labels with no spend are left out. */
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "number" },
    example: { FOOD: 4000, RENT: 150000 },
  })
  byLabel!: Partial<Record<RecipientLabel, number>>;
}
