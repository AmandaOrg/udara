import { Matches } from "class-validator";

export class NameEnquiryDto {
  /** A NUBAN: ten digits. */
  @Matches(/^\d{10}$/)
  accountNumber!: string;

  /** A code from GET /v1/banks. */
  @Matches(/^\d{3,10}$/)
  bankCode!: string;
}
