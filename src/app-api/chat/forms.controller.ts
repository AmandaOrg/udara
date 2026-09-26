import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { AppConversationService } from "./app-conversation.service";
import { KycFormDto, PinFormDto } from "./chat.dto";

/** A person fills these in by hand; ten a minute is already generous. */
const FORMS_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * The native screens for the forms the chat asks for: identity (KYC) and PIN.
 * These replace the WhatsApp Flows for the app (ADR-0002), and the values go
 * to the same handlers in the same in-memory `sensitive` map. They are never
 * chat messages, never stored, and never logged: there is deliberately no
 * logger in this file (S15).
 *
 * Accepted with 202; the outcome arrives in the chat, as it does on WhatsApp.
 * PIN guessing is bounded by the PIN lockout, not by this throttle.
 */
@Controller("v1/forms")
export class FormsController {
  constructor(private readonly chat: AppConversationService) {}

  @Throttle(FORMS_THROTTLE)
  @Post("kyc")
  @HttpCode(HttpStatus.ACCEPTED)
  kyc(@CurrentPrincipal() principal: AppPrincipal, @Body() dto: KycFormDto) {
    return this.chat.submitKyc(principal, dto);
  }

  @Throttle(FORMS_THROTTLE)
  @Post("pin")
  @HttpCode(HttpStatus.ACCEPTED)
  pin(@CurrentPrincipal() principal: AppPrincipal, @Body() dto: PinFormDto) {
    return this.chat.submitPin(principal, dto);
  }
}
