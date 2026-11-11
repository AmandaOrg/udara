import { ApiProperty } from "@nestjs/swagger";
import { SavingsBucketType, SavingsPlanStatus } from "@prisma/client";
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
} from "class-validator";

export class QuickSaveDto {
  @ApiProperty({ enum: SavingsBucketType, enumName: "SavingsBucketType" })
  @IsEnum(SavingsBucketType)
  bucketType!: SavingsBucketType;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(100_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  planId?: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class WithdrawDto {
  @ApiProperty({ enum: SavingsBucketType, enumName: "SavingsBucketType" })
  @IsEnum(SavingsBucketType)
  bucketType!: SavingsBucketType;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(100_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  planId?: string;

  /** 4-digit transfer/security PIN */
  @IsOptional()
  @IsString()
  pin?: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class CreatePlanDto {
  @ApiProperty({ enum: SavingsBucketType, enumName: "SavingsBucketType" })
  @IsEnum(SavingsBucketType)
  bucketType!: SavingsBucketType;

  @IsString()
  @MaxLength(80)
  title!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  targetAmount?: number;

  @IsOptional()
  @IsString()
  tierId?: string;

  @IsOptional()
  @IsNumber()
  durationDays?: number;

  @IsOptional()
  @IsString()
  emoji?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  colorBg?: string;

  @IsOptional()
  @IsString()
  cadence?: string;

  @IsOptional()
  ruleConfig?: Record<string, unknown>;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @IsEnum(SavingsPlanStatus)
  status?: SavingsPlanStatus;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  targetAmount?: number;
}
