import { scrubFreeTextSecrets } from "./scrub-free-text.util";
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  Prisma,
  WhatsappMessage,
  WhatsappMessageDirection,
  WhatsappMessageStatus,
  WhatsappMessageType,
} from "@prisma/client";
import { ParsedInboundMessage } from "./parsers/whatsapp-payload.parser";
import {
  extractSensitive,
  redactRawPayload,
  redactSensitive,
} from "./sensitive-fields.util";

/**
 * Plaintext values for sensitive Flow fields (PIN, BVN/NIN, DOB), carried in
 * memory only. Deliberately NOT part of the persisted WhatsappMessage row —
 * see sensitive-fields.util.ts. Handlers that need a real value (PinService
 * verifying a submission) read it from here; everything else ignores it.
 */
export type SensitiveFields = Record<string, string>;

@Injectable()
export class WhatsappMessageService {
  private readonly logger = new Logger(WhatsappMessageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists an inbound message if we haven't seen its waMessageId before —
   * this unique constraint is the real dedup key, since Meta redelivers
   * webhooks on timeout/retry. Returns isNew: false (no crash) for a
   * duplicate, and for STATUS entries, which aren't inbound messages in our
   * domain model — they're delivery/read receipts for outbound sends.
   *
   * Sensitive Flow fields are stripped from BOTH persisted columns before the
   * write and returned separately as `sensitive`, in memory only. This is the
   * only place that can enforce it: the controller persists here and only then
   * routes, so a handler downstream is already too late to keep a secret out
   * of the database.
   */
  async recordInboundIfNew(
    parsed: ParsedInboundMessage,
    rawPayload: unknown,
  ): Promise<{
    isNew: boolean;
    record: WhatsappMessage | null;
    sensitive: SensitiveFields;
  }> {
    if (parsed.type === WhatsappMessageType.STATUS) {
      this.logger.debug(
        `Status callback for ${parsed.waMessageId}: ${parsed.status}`,
      );
      return { isNew: false, record: null, sensitive: {} };
    }

    const sensitive =
      parsed.type === WhatsappMessageType.FLOW_REPLY
        ? extractSensitive(parsed.responseJson)
        : {};

    const existing = await this.prisma.whatsappMessage.findUnique({
      where: { waMessageId: parsed.waMessageId },
    });
    if (existing) return { isNew: false, record: existing, sensitive };

    try {
      const record = await this.prisma.whatsappMessage.create({
        data: {
          waMessageId: parsed.waMessageId,
          direction: WhatsappMessageDirection.INBOUND,
          type: parsed.type,
          fromNumber: parsed.from,
          // Scrubbed for labelled secrets. Field-name redaction covers the
          // Flow path completely but cannot help when a user types their PIN or
          // BVN as an ordinary message, which happens when a Flow fails to open.
          textBody: scrubOptional(
            parsed.type === WhatsappMessageType.TEXT
              ? parsed.text
              : parsed.type === WhatsappMessageType.IMAGE
                ? parsed.caption
                : undefined,
          ),
          buttonPayload:
            parsed.type === WhatsappMessageType.BUTTON_REPLY
              ? parsed.buttonId
              : parsed.type === WhatsappMessageType.LIST_REPLY
                ? parsed.listId
                : undefined,
          mediaId: "mediaId" in parsed ? parsed.mediaId : undefined,
          mediaMimeType: "mimeType" in parsed ? parsed.mimeType : undefined,
          flowResponseJson:
            parsed.type === WhatsappMessageType.FLOW_REPLY
              ? (redactSensitive(parsed.responseJson) as Prisma.InputJsonValue)
              : undefined,
          rawPayload: redactRawPayload(rawPayload) as Prisma.InputJsonValue,
          status: WhatsappMessageStatus.RECEIVED,
        },
      });
      return { isNew: true, record, sensitive };
    } catch (err) {
      // Unique-constraint race — two overlapping redeliveries of the same
      // message both reached `create` before either committed. Treat as
      // "already recorded" rather than a hard failure.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existingRow = await this.prisma.whatsappMessage.findUniqueOrThrow(
          {
            where: { waMessageId: parsed.waMessageId },
          },
        );
        return { isNew: false, record: existingRow, sensitive };
      }
      throw err;
    }
  }

  async markProcessed(id: string, status: WhatsappMessageStatus) {
    return this.prisma.whatsappMessage.update({
      where: { id },
      data: { status, processedAt: new Date() },
    });
  }

  /** Used for voice transcripts, which are just as capable of carrying a spoken PIN. */
  async updateTextBody(id: string, textBody: string) {
    return this.prisma.whatsappMessage.update({
      where: { id },
      data: { textBody: scrubFreeTextSecrets(textBody) },
    });
  }

  /**
   * Logs an outbound send. `fromNumber` is reused to hold the counterparty's
   * number for outbound rows too (the schema has one "the other party" column,
   * not separate from/to columns) — direction disambiguates which side is us.
   */
  async recordOutbound(params: {
    waMessageId: string;
    to: string;
    type: WhatsappMessageType;
    userId?: string;
    textBody?: string;
    buttonPayload?: string;
    rawPayload: unknown;
  }) {
    return this.prisma.whatsappMessage.create({
      data: {
        waMessageId: params.waMessageId,
        userId: params.userId,
        direction: WhatsappMessageDirection.OUTBOUND,
        type: params.type,
        fromNumber: params.to,
        textBody: params.textBody,
        buttonPayload: params.buttonPayload,
        rawPayload: params.rawPayload as Prisma.InputJsonValue,
        status: WhatsappMessageStatus.PROCESSED,
      },
    });
  }
}

/** scrubFreeTextSecrets, but transparent about undefined. */
function scrubOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : scrubFreeTextSecrets(text);
}
