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
   */
  async recordInboundIfNew(
    parsed: ParsedInboundMessage,
    rawPayload: unknown,
  ): Promise<{ isNew: boolean; record: WhatsappMessage | null }> {
    if (parsed.type === WhatsappMessageType.STATUS) {
      this.logger.debug(
        `Status callback for ${parsed.waMessageId}: ${parsed.status}`,
      );
      return { isNew: false, record: null };
    }

    const existing = await this.prisma.whatsappMessage.findUnique({
      where: { waMessageId: parsed.waMessageId },
    });
    if (existing) return { isNew: false, record: existing };

    try {
      const record = await this.prisma.whatsappMessage.create({
        data: {
          waMessageId: parsed.waMessageId,
          direction: WhatsappMessageDirection.INBOUND,
          type: parsed.type,
          fromNumber: parsed.from,
          textBody:
            parsed.type === WhatsappMessageType.TEXT ? parsed.text : undefined,
          buttonPayload:
            parsed.type === WhatsappMessageType.BUTTON_REPLY
              ? parsed.buttonId
              : parsed.type === WhatsappMessageType.LIST_REPLY
                ? parsed.listId
                : undefined,
          mediaId: "mediaId" in parsed ? parsed.mediaId : undefined,
          mediaMimeType: "mimeType" in parsed ? parsed.mimeType : undefined,
          rawPayload: rawPayload as Prisma.InputJsonValue,
          status: WhatsappMessageStatus.RECEIVED,
        },
      });
      return { isNew: true, record };
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
        return { isNew: false, record: existingRow };
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
