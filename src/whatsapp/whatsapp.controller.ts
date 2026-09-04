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
import { WhatsappService } from "./whatsapp.service";
import { parseInboundPayload } from "./parsers/whatsapp-payload.parser";

/**
 * WhatsApp's typing indicator lasts up to ~25s per trigger, then disappears
 * on its own. A single fire-and-forget call at message-receipt is only good
 * for that long — if actual processing (LLM call, DB writes, Rubies calls)
 * runs longer, the indicator vanishes and the user sees dead air until the
 * reply shows up. Refreshing well under that ceiling keeps it visible for
 * the whole processing window, not just the start of it.
 */
const TYPING_HEARTBEAT_INTERVAL_MS = 8_000;

@Controller("webhooks")
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly messages: WhatsappMessageService,
    private readonly router: WhatsappRouterService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Meta's webhook verification handshake. */
  @Get("whatsapp")
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
  @Post("whatsapp")
  async receive(@Body() payload: unknown, @Res() res: Response) {
    res.sendStatus(200);

    // S13: never serialize the inbound payload into a log line. This runs
    // *before* WhatsappMessageService applies redactSensitive/redactRawPayload,
    // so anything logged here is the raw Flow submission — the plaintext PIN,
    // reset OTP, BVN/NIN and date of birth. A previous debug line here defeated
    // the entire redaction boundary in sensitive-fields.util.ts. Log shape, never
    // content; use the persisted (redacted) WhatsappMessage row to debug.
    const parsedMessages = parseInboundPayload(payload);
    this.logger.debug(`Inbound webhook: ${parsedMessages.length} message(s)`);

    for (const parsed of parsedMessages) {
      try {
        const { isNew, record, sensitive } =
          await this.messages.recordInboundIfNew(parsed, payload);
        // Duplicate redelivery, or a STATUS (delivery/read receipt) callback — nothing to route.
        if (!isNew || !record) continue;

        // Fire-and-forget, in parallel with routing — this is a UX nicety
        // (real "typing…" feedback while we do LLM/DB work), not something
        // that should ever delay or fail the actual reply. The interval
        // keeps re-triggering it for as long as routing is actually in
        // flight, so it stays visible through the full processing time, not
        // just the first ~25s of it — cleared the moment routing settles,
        // success or failure.
        this.whatsapp
          .markAsReadWithTyping(record.waMessageId)
          .catch((err) =>
            this.logger.warn(`markAsReadWithTyping failed: ${String(err)}`),
          );
        const typingHeartbeat = setInterval(() => {
          this.whatsapp
            .markAsReadWithTyping(record.waMessageId)
            .catch((err) =>
              this.logger.warn(`typing heartbeat failed: ${String(err)}`),
            );
        }, TYPING_HEARTBEAT_INTERVAL_MS);

        try {
          await this.router.route(record, sensitive);
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
        } finally {
          clearInterval(typingHeartbeat);
        }
      } catch (err) {
        this.logger.error(
          `Failed to record inbound WhatsApp message: ${String(err)}`,
        );
      }
    }
  }
}
