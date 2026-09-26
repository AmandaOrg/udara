import { plainToInstance } from "class-transformer";
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
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

  // ----- Mobile app API (off unless APP_API_ENABLED=true) -----

  @IsOptional()
  @IsString()
  APP_API_ENABLED?: string;

  @IsOptional()
  @IsString()
  OTP_PEPPER?: string;

  @IsOptional()
  @IsString()
  SMS_DRY_RUN?: string;

  @IsOptional()
  @IsString()
  TERMII_API_KEY?: string;

  @IsOptional()
  @IsString()
  TERMII_SENDER_ID?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  TERMII_BASE_URL?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  SMS_DAILY_CAP?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  APP_ACCESS_TOKEN_TTL_MINUTES?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  APP_REFRESH_TOKEN_TTL_DAYS?: number;

  /** Naira a newly trusted app device may move in its first 24 hours (ADR-0002). */
  @IsOptional()
  @IsInt()
  @Min(0)
  NEW_DEVICE_TRANSFER_CAP?: number;

  /** "true" sends no push notifications; local and e2e only. */
  @IsOptional()
  @IsString()
  PUSH_DRY_RUN?: string;

  /** Needed only if push security is turned on for the Expo project. */
  @IsOptional()
  @IsString()
  EXPO_ACCESS_TOKEN?: string;

  /** The oldest app version the server supports, x.y.z; blank for none. */
  @IsOptional()
  @Matches(/^(\d{1,4}\.\d{1,4}\.\d{1,4})?$/)
  APP_MIN_SUPPORTED_VERSION?: string;

  /** "true" serves the OpenAPI document at /docs. Never in a deployed environment. */
  @IsOptional()
  @IsString()
  APP_API_DOCS?: string;
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

/** Long enough that the pepper cannot be guessed and the codes brute-forced offline. */
const MIN_OTP_PEPPER_LENGTH = 32;

/**
 * The app API only needs its secrets when it is switched on, so deploying this
 * code changes nothing until APP_API_ENABLED is set. Once it is, a missing
 * pepper would make every stored code hash guessable, and a missing SMS
 * credential would silently send no codes; both fail boot instead.
 */
function assertAppApiConfig(config: Record<string, unknown>): void {
  if (String(config.APP_API_ENABLED ?? "").trim() !== "true") return;

  const problems: string[] = [];
  const pepper = String(config.OTP_PEPPER ?? "").trim();
  if (pepper.length < MIN_OTP_PEPPER_LENGTH) {
    problems.push(
      `  OTP_PEPPER: must be at least ${MIN_OTP_PEPPER_LENGTH} characters when APP_API_ENABLED=true`,
    );
  }
  if (String(config.SMS_DRY_RUN ?? "").trim() !== "true") {
    for (const key of ["TERMII_API_KEY", "TERMII_SENDER_ID"]) {
      if (isBlank(config[key])) {
        problems.push(
          `  ${key}: must not be blank when APP_API_ENABLED=true, unless SMS_DRY_RUN=true`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.join("\n")}`,
    );
  }
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
  assertAppApiConfig(config);

  return validated;
}
