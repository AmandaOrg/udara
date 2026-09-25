import { Type } from "class-transformer";
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { DevicePlatform } from "@prisma/client";

export class RequestCodeDto {
  @IsString()
  @MaxLength(32)
  phoneNumber!: string;
}

export class DeviceDto {
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  /**
   * Shown back to the user in WhatsApp and email warnings, so it is kept to
   * plain words: nothing that could pass for a link or a phone number to call.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[\p{L}\p{N} ()'._-]*$/u)
  name?: string;
}

export class VerifyCodeDto {
  @IsString()
  @MaxLength(32)
  phoneNumber!: string;

  @Matches(/^\d{6}$/)
  code!: string;

  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class ChallengeDto {
  @IsString()
  @MaxLength(128)
  challengeToken!: string;
}

export class PinStepUpDto extends ChallengeDto {
  @Matches(/^\d{4}$/)
  pin!: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(128)
  refreshToken!: string;
}
