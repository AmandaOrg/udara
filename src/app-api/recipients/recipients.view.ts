import { ApiProperty } from "@nestjs/swagger";
import { RecipientLabel } from "@prisma/client";

export class RecipientView {
  id!: string;
  /** The user's own name for them ("landlord"), if given. */
  nickname!: string | null;
  accountName!: string | null;
  accountNumber!: string;
  bankCode!: string;
  /** From the bank list; null when that is unavailable. */
  bankName!: string | null;
  @ApiProperty({ enum: RecipientLabel, enumName: "RecipientLabel" })
  label!: RecipientLabel;
  lastUsedAt!: string | null;
}

export class RecipientsView {
  /** Most recently used first. */
  recipients!: RecipientView[];
}
