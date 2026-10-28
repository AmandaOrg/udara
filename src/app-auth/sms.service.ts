import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { AppAuthConfig } from "./app-auth.config";

const DEFAULT_TERMII_BASE_URL = "https://api.ng.termii.com";

/**
 * Sends SMS through Termii. Only used for sign-in codes, so it logs the fact
 * of a send and never the message: the message is the code.
 *
 * The "dnd" channel is Termii's transactional route. It reaches numbers on
 * Nigeria's Do-Not-Disturb register, which the promotional route silently
 * drops, and it needs a sender id Termii has approved for it.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly authConfig: AppAuthConfig,
  ) {}

  /** True when the provider accepted the message. Never throws. */
  async send(to: string, message: string): Promise<boolean> {
    if (this.authConfig.smsDryRun) {
      this.logger.log(`SMS dry-run to ${maskPhone(to)}: ${message}`);
      return true;
    }

    const baseUrl = this.config
      .get<string>("TERMII_BASE_URL", DEFAULT_TERMII_BASE_URL)
      .replace(/\/+$/, "");
    try {
      const response = await firstValueFrom(
        this.http.post<{ message_id?: string; message?: string }>(
          `${baseUrl}/api/sms/send`,
          {
            api_key: this.config.get<string>("TERMII_API_KEY"),
            to,
            from: this.config.get<string>("TERMII_SENDER_ID"),
            sms: message,
            type: "plain",
            channel: "dnd",
          },
        ),
      );
      if (!response.data?.message_id) {
        this.logger.warn(
          `Termii did not accept the SMS to ${maskPhone(to)}: ${response.data?.message ?? "no message id"}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      // Status only: the request config Axios attaches to the error carries the
      // API key and the message body.
      const status =
        (err as { response?: { status?: number } }).response?.status ??
        "no response";
      this.logger.warn(`Termii send to ${maskPhone(to)} failed: ${status}`);
      return false;
    }
  }
}

/** Last four digits only, enough to correlate a log line with a support ticket. */
export function maskPhone(phoneNumber: string): string {
  return `…${phoneNumber.slice(-4)}`;
}
