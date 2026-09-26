import { ApiProperty } from "@nestjs/swagger";
import { RecipientLabel } from "@prisma/client";
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/** The `Idempotency-Key` header: the app's own id for one send attempt. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export class CreateTransferDto {
  /** A NUBAN: ten digits. */
  @Matches(/^\d{10}$/)
  accountNumber!: string;

  /** A code from GET /v1/banks. */
  @Matches(/^\d{3,10}$/)
  bankCode!: string;

  /** Naira, up to kobo. */
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(10_000_000)
  amount!: number;

  /** What the money is for; also the new recipient's tag. */
  @ApiProperty({
    enum: RecipientLabel,
    enumName: "RecipientLabel",
    required: false,
  })
  @IsOptional()
  @IsEnum(RecipientLabel)
  purpose?: RecipientLabel;

  /** A few words on the purpose, when it is OTHER. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** The user's own name for this recipient ("landlord"). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;
}

export class AuthorizeTransferDto {
  /** `pinToken` from the confirm step, or `retryToken` after a wrong PIN. */
  @IsString()
  @MaxLength(128)
  pinToken!: string;

  @Matches(/^\d{4}$/)
  pin!: string;
}
