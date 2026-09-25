import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { OtpService } from "../../app-auth/otp.service";
import {
  Authenticated,
  LoginService,
  StepUpOutcome,
} from "../../app-auth/login.service";
import {
  AppPrincipal,
  SessionService,
  TokenPair,
} from "../../app-auth/session.service";
import {
  isNigerianMobile,
  normalizePhoneNumber,
} from "../../common/phone.util";
import { Public } from "../public.decorator";
import { CurrentPrincipal } from "../current-principal.decorator";
import {
  ChallengeDto,
  PinStepUpDto,
  RefreshDto,
  RequestCodeDto,
  VerifyCodeDto,
} from "./auth.dto";

/** 423 Locked; Nest 10's HttpStatus enum has no member for it. */
const HTTP_LOCKED = 423;

/** Tighter than the global limit: these routes cost an SMS or guard a guess. */
const SIGN_IN_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Signing in to the mobile app. Deliberately no logger: every body here
 * carries a phone number, a code, a PIN or a token (S15).
 *
 * The code request answers the same way whether or not the number has an
 * account, so it cannot be used to find out who uses Udara.
 */
@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly login: LoginService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post("otp")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(@Body() dto: RequestCodeDto, @Ip() ip: string) {
    const phoneNumber = nigerianMobileOrThrow(dto.phoneNumber);
    const result = await this.otp.request(phoneNumber, ip || null);
    if (result.ok) {
      return { expiresAt: result.expiresAt, resendAfter: result.resendAfter };
    }
    if (result.reason === "too_soon") {
      throw new HttpException(
        { error: "too_soon", retryAfter: result.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (result.reason === "rate_limited") {
      throw new HttpException(
        { error: "rate_limited" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw new HttpException(
      { error: "unavailable" },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  async verify(@Body() dto: VerifyCodeDto) {
    const outcome = await this.login.signIn({
      phoneNumber: nigerianMobileOrThrow(dto.phoneNumber),
      code: dto.code,
      platform: dto.device.platform,
      deviceName: dto.device.name?.trim() || null,
    });
    if (outcome.status === "authenticated") return signedIn(outcome);
    if (outcome.status === "step_up_required") {
      return {
        status: outcome.status,
        stepUp: {
          method: outcome.method,
          challengeToken: outcome.challengeToken,
          expiresAt: outcome.expiresAt,
        },
      };
    }
    throw new HttpException(
      {
        error: outcome.reason === "invalid" ? "invalid_code" : outcome.reason,
        ...(outcome.attemptsLeft !== undefined
          ? { attemptsLeft: outcome.attemptsLeft }
          : {}),
      },
      HttpStatus.UNAUTHORIZED,
    );
  }

  @Public()
  @Throttle(SIGN_IN_THROTTLE)
  @Post("step-up/pin")
  @HttpCode(HttpStatus.OK)
  async stepUpWithPin(@Body() dto: PinStepUpDto) {
    return stepUpResponse(
      await this.login.stepUpWithPin(dto.challengeToken, dto.pin),
    );
  }

  /** Polled while the user answers on WhatsApp. 202 means "still waiting". */
  @Public()
  @Post("step-up/whatsapp")
  @HttpCode(HttpStatus.OK)
  async pollWhatsapp(
    @Body() dto: ChallengeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.login.pollWhatsappApproval(dto.challengeToken);
    if (outcome.status === "pending") {
      res.status(HttpStatus.ACCEPTED);
      return { status: "pending" };
    }
    return stepUpResponse(outcome);
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const result = await this.sessions.refresh(dto.refreshToken);
    if (result.ok) return { tokens: tokenBody(result.tokens) };
    if (result.reason === "in_progress") {
      throw new HttpException(
        { error: "refresh_in_progress" },
        HttpStatus.CONFLICT,
      );
    }
    throw new HttpException(
      { error: "invalid_refresh_token" },
      HttpStatus.UNAUTHORIZED,
    );
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentPrincipal() principal: AppPrincipal): Promise<void> {
    await this.sessions.logout(principal);
  }
}

/** v1 accepts Nigerian mobiles only; normalised to the canonical form. */
function nigerianMobileOrThrow(raw: string): string {
  const phoneNumber = normalizePhoneNumber(raw);
  if (!phoneNumber || !isNigerianMobile(phoneNumber)) {
    throw new BadRequestException({ error: "invalid_phone_number" });
  }
  return phoneNumber;
}

function tokenBody(tokens: TokenPair) {
  return {
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

function signedIn(outcome: Authenticated) {
  return {
    status: outcome.status,
    tokens: tokenBody(outcome.tokens),
    user: { id: outcome.userId, isNewUser: outcome.isNewUser },
  };
}

function stepUpResponse(outcome: StepUpOutcome) {
  switch (outcome.status) {
    case "authenticated":
      return signedIn(outcome);
    case "pending":
      // Only the WhatsApp poll can be pending, and it answers 202 itself.
      return { status: outcome.status };
    case "wrong_pin":
      throw new HttpException(
        { error: "wrong_pin", message: outcome.message },
        HttpStatus.UNAUTHORIZED,
      );
    case "locked":
      throw new HttpException(
        { error: "pin_locked", lockedUntil: outcome.lockedUntil },
        HTTP_LOCKED,
      );
    case "denied":
      throw new HttpException({ error: "denied" }, HttpStatus.FORBIDDEN);
    case "expired":
      throw new HttpException({ error: "expired" }, HttpStatus.GONE);
    case "invalid_challenge":
      throw new HttpException(
        { error: "invalid_challenge" },
        HttpStatus.UNAUTHORIZED,
      );
  }
}
