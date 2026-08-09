import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { WhatsappMessageType } from "@prisma/client";
import { WhatsappMessageService } from "./whatsapp-message.service";

export interface InteractiveButton {
  id: string;
  title: string; // Meta caps this at 20 chars — truncated here to match what's actually shown
}

interface MetaSendResponse {
  messages?: { id: string }[];
}

/**
 * Thin wrapper around WhatsApp Cloud API. Every send is logged as an outbound
 * WhatsappMessage row (audit trail, and so Phase 8's button-id namespacing has
 * a record of "the message that asked this question" to reference later) —
 * the `type` column is informational for outbound rows specifically (it
 * doesn't have dedicated INTERACTIVE/TEMPLATE members, only inbound-content
 * types), full fidelity lives in rawPayload/textBody regardless.
 */
@Injectable()
export class WhatsappService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly messages: WhatsappMessageService,
  ) {}

  private get phoneNumberId(): string {
    return this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID", "");
  }

  private get authHeaders() {
    const token = this.config.get<string>("WHATSAPP_ACCESS_TOKEN");
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  private async post(body: Record<string, unknown>): Promise<MetaSendResponse> {
    const response = await firstValueFrom(
      this.http.post<MetaSendResponse>(
        `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
        body,
        this.authHeaders,
      ),
    );
    return response.data;
  }

  async sendText(
    to: string,
    body: string,
    userId?: string,
  ): Promise<{ waMessageId: string }> {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    };
    const response = await this.post(payload);
    const waMessageId = response.messages?.[0]?.id ?? "";
    await this.messages.recordOutbound({
      waMessageId,
      to,
      type: WhatsappMessageType.TEXT,
      userId,
      textBody: body,
      rawPayload: payload,
    });
    return { waMessageId };
  }

  /** Up to 3 reply buttons — WhatsApp's own hard limit for this message type. */
  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: InteractiveButton[],
    userId?: string,
  ): Promise<{ waMessageId: string }> {
    if (buttons.length === 0 || buttons.length > 3) {
      throw new Error(
        `sendInteractiveButtons: WhatsApp allows 1-3 buttons, got ${buttons.length}`,
      );
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    };
    const response = await this.post(payload);
    const waMessageId = response.messages?.[0]?.id ?? "";
    await this.messages.recordOutbound({
      waMessageId,
      to,
      type: WhatsappMessageType.TEXT,
      userId,
      textBody: bodyText,
      rawPayload: payload,
    });
    return { waMessageId };
  }

  /**
   * Sends a pre-approved Meta message template — required once 24h has passed
   * since the user's last inbound message, since Meta blocks free-form sends
   * outside that window. Template approval itself happens in Meta Business
   * Manager, not in code — see Phase 9's AllowanceScheduler for where this is
   * actually used.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
    userId?: string,
  ): Promise<{ waMessageId: string }> {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    };
    const response = await this.post(payload);
    const waMessageId = response.messages?.[0]?.id ?? "";
    await this.messages.recordOutbound({
      waMessageId,
      to,
      type: WhatsappMessageType.TEXT,
      userId,
      textBody: `[template:${templateName}]`,
      rawPayload: payload,
    });
    return { waMessageId };
  }

  /**
   * TODO (post-v0 fast-follow, not built now): download a media object's
   * bytes via Meta's two-step media API — GET /{media-id} for a short-lived
   * URL, then GET that URL with the same bearer token. Typed now so the audio
   * transcription fast-follow has a real seam to plug into.
   * WhatsappRouterService's AUDIO branch does not call this yet — it replies
   * with a static "please type that instead" fallback (deliberate v0 scope
   * decision, see the build-out plan).
   */
  async downloadMedia(
    _mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    throw new Error(
      "Not implemented — audio/media download is a post-v0 fast-follow",
    );
  }
}
