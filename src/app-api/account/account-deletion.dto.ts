import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class RequestAccountDeletionDto {
  /** Required when the account has a PIN; checked under the payments lockout. */
  @IsOptional()
  @Matches(/^\d{4}$/)
  pin?: string;

  /** Why, if the user wants to say. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
