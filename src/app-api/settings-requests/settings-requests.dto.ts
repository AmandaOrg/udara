import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * What the app may ask the managers for. Closing the account is not here: it
 * has its own route, with its own checks (ADR-0003).
 */
export const FILEABLE_REQUEST_TYPES = [
  "window_hours",
  "override_fees",
  "exit_restrictions",
  "other",
] as const;
export type FileableRequestType = (typeof FILEABLE_REQUEST_TYPES)[number];

export class CreateSettingsRequestDto {
  @ApiProperty({ enum: FILEABLE_REQUEST_TYPES })
  @IsIn(FILEABLE_REQUEST_TYPES)
  type!: FileableRequestType;

  /** What should change, in the user's words. */
  @IsString()
  @Length(2, 500)
  @Matches(/\S/)
  requestedChange!: string;

  /** Why, if they said. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
