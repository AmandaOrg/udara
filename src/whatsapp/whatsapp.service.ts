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

export interface ListRow {
  id: string;
  title: string; // Meta caps this at 24 chars — truncated here; put the full text in `description` if it doesn't fit
  description?: string; // Meta caps this at 72 chars
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
  ) { }

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
   * A WhatsApp "list" message — up to 10 rows, opened via a button. Used for
   * the onboarding script's structured multiple-choice questions, which have
   * up to 6 options each (sendInteractiveButtons' 3-button cap can't fit
   * those; this is the WhatsApp-native way to offer more than 3 choices
   * without falling back to typed free text).
   */
  async sendListMessage(
    to: string,
    bodyText: string,
    buttonLabel: string,
    rows: ListRow[],
    userId?: string,
  ): Promise<{ waMessageId: string }> {
    if (rows.length === 0 || rows.length > 10) {
      throw new Error(
        `sendListMessage: WhatsApp allows 1-10 rows, got ${rows.length}`,
      );
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [
            {
              rows: rows.map((r) => ({
                id: r.id,
                title: r.title.slice(0, 24),
                description: r.description?.slice(0, 72),
              })),
            },
          ],
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
   * Sends a WhatsApp Flow — a native popup form. Used for the Trust Moment
   * KYC step (BVN/NIN + DOB + email) specifically so that data collection is
   * a structured form submission the app parses deterministically, never
   * something the AI extracts from free text. `flowToken` is caller-supplied
   * (regenerate on retry) so a resent flow after a Rubies failure can't be
   * confused with a stale earlier submission.
   */
  async sendFlow(params: {
    to: string;
    flowId: string;
    flowToken: string;
    screenId: string;
    headerText: string;
    bodyText: string;
    ctaText: string;
    userId?: string;
  }): Promise<{ waMessageId: string }> {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: params.headerText },
        body: { text: params.bodyText },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: params.flowToken,
            flow_id: params.flowId,
            flow_cta: params.ctaText,
            flow_action: "navigate",
            // No `data` key: an explicit empty object here fails Meta's Graph
            // API with "(#131009) ... data in flow_action_payload for CTA
            // flow must be of type dynamic_object" — confirmed live against
            // the API. Omitting the key entirely (this screen has no
            // declared dynamic inputs) is what actually works.
            flow_action_payload: { screen: params.screenId },
          },
        },
      },
    };
    const response = await this.post(payload);
    const waMessageId = response.messages?.[0]?.id ?? "";
    await this.messages.recordOutbound({
      waMessageId,
      to: params.to,
      type: WhatsappMessageType.TEXT,
      userId: params.userId,
      textBody: `[flow:${params.flowId}]`,
      rawPayload: payload,
    });
    return { waMessageId };
  }

  /**
   * Marks the inbound message as read and shows WhatsApp's native "typing…"
   * indicator to the user. Meta clears it automatically once we send the
   * next message (or after ~25s, whichever comes first), so this is a
   * fire-and-forget call made the moment a message comes in — it's what
   * gives the user real-time feedback while we're still doing LLM/DB work,
   * replacing the old approach of faking that feeling with artificial
   * send-delays (see ChunkedMessengerService). No outbound WhatsappMessage
   * row is recorded — this isn't a message, just a status update.
   */
  async markAsReadWithTyping(waMessageId: string): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
      typing_indicator: { type: "text" },
    });
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
