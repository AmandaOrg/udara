import { Matches } from "class-validator";

export class ConfirmEmailCodeDto {
  /** The 6-digit code from the email. */
  @Matches(/^\d{6}$/)
  code!: string;
}
