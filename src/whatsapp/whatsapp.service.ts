import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";

/**
 * Thin wrapper around WhatsApp Cloud API — another piece you've already
 * built before, so left minimal/typed rather than reimplemented.
 */
@Injectable()
export class WhatsappService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async sendText(to: string, body: string): Promise<void> {
    const phoneNumberId = this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    const token = this.config.get<string>("WHATSAPP_ACCESS_TOKEN");

    await firstValueFrom(
      this.http.post(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
  }

  // TODO: sendInteractiveButtons(...) for v0.5 (PRD notes buttons come after
  // v0 — text-only replies are enough for the first two weeks).
}
