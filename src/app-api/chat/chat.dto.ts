import { Type } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * The app's own id for something it sent, so a retry after a dropped
 * connection is recognised rather than handled twice.
 */
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class ChoiceDto {
  /** The buttons or list message the choice was made on. */
  @IsUUID()
  messageId!: string;

  @IsString()
  @MaxLength(200)
  choiceId!: string;
}

/** Exactly one of `text` and `reply`. */
export class SendMessageDto {
  @Matches(CLIENT_MESSAGE_ID)
  clientMessageId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Matches(/\S/)
  text?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ChoiceDto)
  reply?: ChoiceDto;
}

export class StartDto {
  @Matches(CLIENT_MESSAGE_ID)
  clientMessageId!: string;
}

export class ListMessagesQueryDto {
  /** The `seq` of the last message the app already has. */
  @IsOptional()
  @Matches(/^\d{1,19}$/)
  after?: string;

  /** Hold the request open this long for something new. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(25_000)
  waitMs?: number;
}

/**
 * The identity form. Shapes only; OnboardingService still checks every field
 * and answers in the chat, exactly as for the WhatsApp Flow.
 */
export class KycFormDto {
  @Matches(CLIENT_MESSAGE_ID)
  clientMessageId!: string;

  /** From the form request in the chat. */
  @IsString()
  @MaxLength(128)
  token!: string;

  @IsString()
  @MaxLength(80)
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  middleName?: string;

  @IsString()
  @MaxLength(80)
  lastName!: string;

  @IsIn(["BVN", "NIN"])
  idType!: "BVN" | "NIN";

  @Matches(/^\d{11}$/)
  idNumber!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;
}

/** PIN entry, setup (`pinConfirm`) or reset (`pinConfirm` and the emailed `otp`). */
export class PinFormDto {
  @Matches(CLIENT_MESSAGE_ID)
  clientMessageId!: string;

  @IsString()
  @MaxLength(128)
  token!: string;

  @Matches(/^\d{4}$/)
  pin!: string;

  @IsOptional()
  @Matches(/^\d{4}$/)
  pinConfirm?: string;

  @IsOptional()
  @Matches(/^\d{6}$/)
  otp?: string;
}
