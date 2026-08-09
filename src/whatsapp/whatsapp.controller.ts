import { Controller, Get, Post, Query, Body, Res } from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { WhatsappService } from "./whatsapp.service";
import { AllowanceService } from "../allowance/allowance.service";

@Controller("webhooks/whatsapp")
export class WhatsappController {
  constructor(
    private readonly config: ConfigService,
    private readonly whatsapp: WhatsappService,
    private readonly allowance: AllowanceService,
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
   * Inbound message entry point. This is the top of the flow described in
   * PRD section 5: webhook-in -> window check -> allowance check ->
   * override-fee logic -> recipient tagging/confirmation -> Rubies call ->
   * response-out. Routing to onboarding vs. transfer-intent vs. general
   * conversation happens here — kept as a TODO since the message-parsing
   * shape depends on how you structure the conversation-model call.
   */
  @Post()
  async receive(@Body() payload: any, @Res() res: Response) {
    res.sendStatus(200); // ack Meta immediately; process async

    // TODO: parse payload -> { from, text } per WhatsApp Cloud API shape
    // TODO: look up/create User by `from`
    // TODO: if mid-onboarding -> OnboardingService
    // TODO: if transfer intent -> AllowanceService.evaluateSpend -> confirm -> RubiesService.initiateTransfer
    // TODO: else -> general conversation / manager escalation routing
  }
}
