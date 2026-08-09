import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { WhatsappMessageStatus } from "@prisma/client";
import { WhatsappSignatureGuard } from "./whatsapp-signature.guard";
import { WhatsappMessageService } from "./whatsapp-message.service";
import { WhatsappRouterService } from "./whatsapp-router.service";
import { parseInboundPayload } from "./parsers/whatsapp-payload.parser";

@Controller("webhooks/whatsapp")
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly messages: WhatsappMessageService,
    private readonly router: WhatsappRouterService,
  ) {}

  /** Meta's webhook verification handshake. */
  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    const expected = this.config.get<string>("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    if (mode === "subscribe" && token === expected) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }

  /**
   * Inbound message entry point — PRD §5's flow (webhook-in -> window check ->
   * allowance check -> override-fee logic -> recipient tagging/confirmation ->
   * Rubies call -> response-out) starts here. Acks Meta immediately (well
   * under its ~20s timeout) and processes every parsed message afterward —
   * fire-and-forget from the response's perspective, but each message is
   * individually try/caught so one bad message can never crash the process or
   * block processing/redelivery of the rest of the batch.
   */
  @UseGuards(WhatsappSignatureGuard)
  @Post()
  async receive(@Body() payload: unknown, @Res() res: Response) {
    res.sendStatus(200);

    const parsedMessages = parseInboundPayload(payload);

    for (const parsed of parsedMessages) {
      try {
        const { isNew, record } = await this.messages.recordInboundIfNew(
          parsed,
          payload,
        );
        // Duplicate redelivery, or a STATUS (delivery/read receipt) callback — nothing to route.
        if (!isNew || !record) continue;

        try {
          await this.router.route(record);
          await this.messages.markProcessed(
            record.id,
            WhatsappMessageStatus.PROCESSED,
          );
        } catch (err) {
          this.logger.error(
            `Failed to route WhatsApp message ${record.id}: ${String(err)}`,
          );
          await this.messages.markProcessed(
            record.id,
            WhatsappMessageStatus.FAILED,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to record inbound WhatsApp message: ${String(err)}`,
        );
      }
    }
  }
}
