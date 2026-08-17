import { WhatsappMessageType } from "@prisma/client";

/**
 * Discriminated union over every inbound thing Meta's webhook can send us,
 * matching WhatsappMessageType 1:1. STATUS entries (delivery/read receipts for
 * messages *we* sent) arrive on the same webhook as real inbound messages —
 * they're parsed here but are not persisted as WhatsappMessage rows (see
 * WhatsappMessageService.recordInboundIfNew) since they aren't inbound
 * messages in our domain model, just delivery-status callbacks.
 */
export type ParsedInboundMessage =
  | {
      type: typeof WhatsappMessageType.TEXT;
      waMessageId: string;
      from: string;
      timestamp: string;
      text: string;
    }
  | {
      type: typeof WhatsappMessageType.BUTTON_REPLY;
      waMessageId: string;
      from: string;
      timestamp: string;
      buttonId: string;
      buttonTitle: string;
    }
  | {
      type: typeof WhatsappMessageType.LIST_REPLY;
      waMessageId: string;
      from: string;
      timestamp: string;
      listId: string;
      listTitle: string;
    }
  | {
      type: typeof WhatsappMessageType.FLOW_REPLY;
      waMessageId: string;
      from: string;
      timestamp: string;
      /** Parsed `interactive.nfm_reply.response_json` — whatever field names the flow's own payload used. */
      responseJson: Record<string, unknown>;
    }
  | {
      type: typeof WhatsappMessageType.AUDIO;
      waMessageId: string;
      from: string;
      timestamp: string;
      mediaId: string;
      mimeType: string;
    }
  | {
      type: typeof WhatsappMessageType.IMAGE;
      waMessageId: string;
      from: string;
      timestamp: string;
      mediaId: string;
      mimeType: string;
      caption?: string;
    }
  | {
      type: typeof WhatsappMessageType.DOCUMENT;
      waMessageId: string;
      from: string;
      timestamp: string;
      mediaId: string;
      mimeType: string;
      filename?: string;
    }
  | {
      type: typeof WhatsappMessageType.LOCATION;
      waMessageId: string;
      from: string;
      timestamp: string;
      latitude: number;
      longitude: number;
    }
  | {
      type: typeof WhatsappMessageType.STATUS;
      waMessageId: string;
      status: string;
      recipientId: string;
      timestamp: string;
    }
  | {
      type: typeof WhatsappMessageType.UNKNOWN;
      waMessageId: string;
      from: string;
      timestamp: string;
      raw: unknown;
    };

interface MetaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: "button_reply" | "list_reply" | "nfm_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { name: string; body: string; response_json: string };
  };
  button?: { text: string; payload: string }; // legacy quick-reply-button messages
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string };
  location?: { latitude: number; longitude: number };
}

interface MetaStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

/**
 * Parses one Meta webhook POST body into a flat list of ParsedInboundMessage.
 * Meta batches multiple entries/changes/messages into a single webhook call,
 * so this always returns an array, even for the common case of exactly one
 * message.
 */
export function parseInboundPayload(payload: unknown): ParsedInboundMessage[] {
  const results: ParsedInboundMessage[] = [];
  const entries =
    isRecord(payload) && Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes =
      isRecord(entry) && Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = isRecord(change) ? change.value : undefined;
      if (!isRecord(value)) continue;

      const messages = Array.isArray(value.messages)
        ? (value.messages as MetaMessage[])
        : [];
      for (const message of messages) {
        results.push(parseMessage(message));
      }

      const statuses = Array.isArray(value.statuses)
        ? (value.statuses as MetaStatus[])
        : [];
      for (const status of statuses) {
        results.push({
          type: WhatsappMessageType.STATUS,
          waMessageId: status.id,
          status: status.status,
          recipientId: status.recipient_id,
          timestamp: status.timestamp,
        });
      }
    }
  }

  return results;
}

function parseMessage(message: MetaMessage): ParsedInboundMessage {
  const base = {
    waMessageId: message.id,
    from: message.from,
    timestamp: message.timestamp,
  };

  switch (message.type) {
    case "text":
      return {
        ...base,
        type: WhatsappMessageType.TEXT,
        text: message.text?.body ?? "",
      };

    case "interactive":
      if (
        message.interactive?.type === "button_reply" &&
        message.interactive.button_reply
      ) {
        return {
          ...base,
          type: WhatsappMessageType.BUTTON_REPLY,
          buttonId: message.interactive.button_reply.id,
          buttonTitle: message.interactive.button_reply.title,
        };
      }
      if (
        message.interactive?.type === "list_reply" &&
        message.interactive.list_reply
      ) {
        return {
          ...base,
          type: WhatsappMessageType.LIST_REPLY,
          listId: message.interactive.list_reply.id,
          listTitle: message.interactive.list_reply.title,
        };
      }
      if (
        message.interactive?.type === "nfm_reply" &&
        message.interactive.nfm_reply
      ) {
        let responseJson: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(
            message.interactive.nfm_reply.response_json,
          );
          if (isRecord(parsed)) responseJson = parsed;
        } catch {
          // Malformed response_json — leave responseJson empty; the caller
          // (OnboardingService) treats missing fields as "ask again."
        }
        return {
          ...base,
          type: WhatsappMessageType.FLOW_REPLY,
          responseJson,
        };
      }
      return { ...base, type: WhatsappMessageType.UNKNOWN, raw: message };

    case "button":
      // Legacy template quick-reply button (distinct from the modern `interactive` type).
      return {
        ...base,
        type: WhatsappMessageType.BUTTON_REPLY,
        buttonId: message.button?.payload ?? "",
        buttonTitle: message.button?.text ?? "",
      };

    case "audio":
      return {
        ...base,
        type: WhatsappMessageType.AUDIO,
        mediaId: message.audio?.id ?? "",
        mimeType: message.audio?.mime_type ?? "",
      };

    case "image":
      return {
        ...base,
        type: WhatsappMessageType.IMAGE,
        mediaId: message.image?.id ?? "",
        mimeType: message.image?.mime_type ?? "",
        caption: message.image?.caption,
      };

    case "document":
      return {
        ...base,
        type: WhatsappMessageType.DOCUMENT,
        mediaId: message.document?.id ?? "",
        mimeType: message.document?.mime_type ?? "",
        filename: message.document?.filename,
      };

    case "location":
      return {
        ...base,
        type: WhatsappMessageType.LOCATION,
        latitude: message.location?.latitude ?? 0,
        longitude: message.location?.longitude ?? 0,
      };

    default:
      return { ...base, type: WhatsappMessageType.UNKNOWN, raw: message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
