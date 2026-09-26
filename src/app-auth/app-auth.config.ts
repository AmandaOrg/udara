import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * App sign-in settings, read in one place with their defaults. Boot-time
 * validation (config/env.validation.ts) has already rejected a missing pepper
 * or SMS key whenever the app API is switched on.
 */
@Injectable()
export class AppAuthConfig {
  constructor(private readonly config: ConfigService) {}

  get otpPepper(): string {
    const pepper = this.config.get<string>("OTP_PEPPER", "").trim();
    if (!pepper) {
      // Only reachable with the app API off, where nothing should be issuing
      // codes. Refuse rather than hash under an empty key.
      throw new Error("OTP_PEPPER is not set");
    }
    return pepper;
  }

  get smsDryRun(): boolean {
    return this.config.get<string>("SMS_DRY_RUN") === "true";
  }

  get smsDailyCap(): number {
    return Number(this.config.get("SMS_DAILY_CAP", 500));
  }

  get accessTtlMs(): number {
    return Number(this.config.get("APP_ACCESS_TOKEN_TTL_MINUTES", 15)) * 60_000;
  }

  /** Naira; see NewDeviceCapService. */
  get newDeviceTransferCap(): number {
    return Number(this.config.get("NEW_DEVICE_TRANSFER_CAP", 20_000));
  }

  get refreshTtlMs(): number {
    return (
      Number(this.config.get("APP_REFRESH_TOKEN_TTL_DAYS", 30)) * 86_400_000
    );
  }
}
