import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AppPrincipal } from "../../app-auth/session.service";
import { EmailVerificationService } from "../../app-auth/email-verification.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { ConfirmEmailCodeDto } from "./email-verification.dto";
import {
  EmailCodeSentView,
  EmailVerifiedView,
} from "./email-verification.view";

/** Each start is an email sent; the service caps them per hour as well. */
const START_THROTTLE = { default: { limit: 5, ttl: 60 * 60_000 } };
/** A person types a code; the attempt cap on the code is the real bound. */
const CONFIRM_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Proving the email address on file is the user's: a code sent there, typed
 * into the app. The address itself cannot be changed here, by design: it is
 * what a PIN reset sends its code to (see PinGateService.requestPinReset).
 */
@Controller("v1/email/verify")
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}

  @Throttle(START_THROTTLE)
  @Post("start")
  @HttpCode(HttpStatus.OK)
  async start(
    @CurrentPrincipal() principal: AppPrincipal,
  ): Promise<EmailCodeSentView> {
    const result = await this.verification.start(principal.userId);
    if (result.ok) {
      return {
        sentTo: result.sentTo,
        expiresAt: result.expiresAt.toISOString(),
        resendAfter: result.resendAfter.toISOString(),
      };
    }
    switch (result.reason) {
      case "no_email":
      case "already_verified":
        throw new ConflictException({ error: result.reason });
      case "too_soon":
        throw new HttpException(
          { error: "too_soon", retryAfter: result.retryAfter.toISOString() },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "too_many_codes":
        throw new HttpException(
          { error: "too_many_codes" },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case "email_unavailable":
        throw new ServiceUnavailableException({ error: "email_unavailable" });
    }
  }

  @Throttle(CONFIRM_THROTTLE)
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: ConfirmEmailCodeDto,
  ): Promise<EmailVerifiedView> {
    const result = await this.verification.confirm(principal.userId, dto.code);
    if (result.ok) return { verified: true };
    throw new UnprocessableEntityException({
      error: result.reason,
      ...("attemptsLeft" in result && result.attemptsLeft !== undefined
        ? { attemptsLeft: result.attemptsLeft }
        : {}),
    });
  }
}
