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
 * later phases add new required-at-runtime vars (AI_PROVIDER, RUBIES_STAGE, etc.),
 * extend this class rather than leaving them unchecked.
 *
 * The two webhook signing secrets are the exception: they are structurally optional
 * here but enforced below in `assertWebhookSecretsPresent`, because a blank value
 * silently disables signature verification rather than failing loudly.
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

  @IsOptional()
  @IsString()
  DEEPGRAM_API_KEY?: string;

  @IsOptional()
  @IsString()
  DEEPGRAM_STT_MODEL?: string;

  @IsOptional()
  @IsString()
  DEEPGRAM_LANGUAGE?: string;

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

  @IsOptional()
  @IsString()
  ALLOW_UNSIGNED_WEBHOOKS?: string;

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsOptional()
  @IsString()
  SENTRY_ENVIRONMENT?: string;

  @IsOptional()
  @IsString()
  DISABLE_SCHEDULERS?: string;
}

/** Webhook signing secrets. Blank means "accept forged requests", so blank is opt-in. */
const WEBHOOK_SECRETS = ["WHATSAPP_APP_SECRET", "RUBIES_SECRET_KEY"] as const;

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * S2/S3: both signature guards fall back to accepting unverified requests when
 * their secret is blank, which is what makes local and e2e runs possible without
 * Meta or Rubies credentials. Left implicit, one missing variable in a deployed
 * environment silently turns the webhooks into an open endpoint — anyone can drive
 * the bot as any phone number or fabricate an incoming credit.
 *
 * So the escape hatch has to be asked for. Note this deliberately does NOT key off
 * NODE_ENV: nothing in the deployment sets it (the Dockerfile that does is unused —
 * Railway builds with Railpack), so a NODE_ENV check would never fire in the one
 * environment it exists to protect.
 */
function assertWebhookSecretsPresent(config: Record<string, unknown>): void {
  if (String(config.ALLOW_UNSIGNED_WEBHOOKS ?? "").trim() === "true") return;

  const missing = WEBHOOK_SECRETS.filter((key) => isBlank(config[key]));
  if (missing.length === 0) return;

  throw new Error(
    `Invalid environment configuration:\n` +
      missing.map((key) => `  ${key}: must not be blank`).join("\n") +
      `\n\nThese sign the inbound webhooks. Without them the signature guards accept ` +
      `unverified requests from anyone.\nSet them, or set ALLOW_UNSIGNED_WEBHOOKS=true ` +
      `to opt into unsigned webhooks for local and e2e runs.`,
  );
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

  // Deliberately after validateSync: @IsOptional() short-circuits every other
  // validator on an empty value, so this cannot be expressed as a decorator.
  assertWebhookSecretsPresent(config);

  return validated;
}
