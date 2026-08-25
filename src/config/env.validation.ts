import { plainToInstance } from "class-transformer";
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from "class-validator";

/**
 * Boot-time env validation — structural checks only (right types, sane ranges) for
 * vars that are load-bearing today. External-service secrets (WhatsApp/Rubies/AI keys)
 * are validated as optional strings: this is a dev scaffold with no real credentials
 * yet, and the services that actually need them (signature guards, Rubies/LLM clients)
 * raise their own clear errors when a call is attempted without one configured. As
 * later phases add new required-at-runtime vars (WHATSAPP_APP_SECRET, AI_PROVIDER,
 * RUBIES_STAGE, etc.), extend this class rather than leaving them unchecked.
 */
class EnvironmentVariables {
  @IsUrl({
    require_tld: false,
    protocols: ["postgresql", "postgres"],
    require_protocol: true,
  })
  DATABASE_URL: string;

  @IsOptional()
  @IsString()
  WHATSAPP_PHONE_NUMBER_ID?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_ACCESS_TOKEN?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_APP_SECRET?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_WINDOW_OPEN_TEMPLATE_NAME?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  RUBIES_BASE_URL?: string;

  @IsOptional()
  @IsString()
  RUBIES_STAGE?: string;

  @IsOptional()
  @IsString()
  RUBIES_API_KEY?: string;

  @IsOptional()
  @IsString()
  RUBIES_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  RUBIES_DRY_RUN?: string;

  @IsOptional()
  @IsString()
  RUBIES_FEES_ACCOUNT_NUMBER?: string;

  @IsOptional()
  @IsString()
  RUBIES_FEES_BANK_CODE?: string;

  @IsOptional()
  @IsString()
  AI_PROVIDER?: string;

  @IsOptional()
  @IsString()
  CLASSIFIER_MODEL_API_KEY?: string;

  @IsOptional()
  @IsString()
  CONVERSATION_MODEL_API_KEY?: string;

  @IsOptional()
  @IsString()
  CLASSIFIER_MODEL_NAME?: string;

  @IsOptional()
  @IsString()
  CONVERSATION_MODEL_NAME?: string;

  @IsOptional()
  @IsString()
  BEDROCK_BASE_URL?: string;

  @IsOptional()
  @IsString()
  BEDROCK_API_KEY?: string;

  @IsOptional()
  @IsString()
  AWS_BEARER_TOKEN_BEDROCK?: string;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional()
  @IsString()
  OPENAI_BASE_URL?: string;

  @IsOptional()
  @IsString()
  BEDROCK_FAST_MODEL?: string;

  @IsOptional()
  @IsString()
  BEDROCK_MODEL?: string;

  @IsInt()
  @Min(0)
  @Max(23)
  DAILY_WINDOW_START_HOUR: number;

  @IsInt()
  @Min(0)
  @Max(23)
  DAILY_WINDOW_END_HOUR: number;

  @IsNumber()
  @Min(0)
  EARLY_ACCESS_FLAT_FEE: number;

  @IsNumber()
  @Min(0)
  EARLY_ACCESS_PERCENT_FEE: number;

  @IsNumber()
  @Min(0)
  BORROW_FLAT_FEE: number;

  @IsNumber()
  @Min(0)
  BORROW_PERCENT_FEE: number;

  @IsInt()
  @Min(0)
  SETTINGS_CHANGE_MIN_DAYS: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  MANAGER_INITIAL_REPLY_DELAY_HOURS?: number;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `  ${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`,
      )
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return validated;
}
