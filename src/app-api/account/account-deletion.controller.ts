import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import type { AppPrincipal } from "../../app-auth/session.service";
import { PinService } from "../../pin/pin.service";
import {
  AccountClosureService,
  ClosureRequestResult,
} from "../../account-closure/account-closure.service";
import { closureDueBy } from "../../account-closure/retention-policy";
import { closureNotice } from "../../account-closure/closure-copy";
import { CurrentPrincipal } from "../current-principal.decorator";
import { inApp } from "../payments.util";
import { toSettingsRequestView } from "../settings-requests/settings-requests.view";
import { RequestAccountDeletionDto } from "./account-deletion.dto";
import {
  AccountDeletionRequestedView,
  AccountDeletionView,
} from "./account-deletion.view";

/** 423, as sign-in answers a locked PIN. Not in this Nest version's HttpStatus. */
const HTTP_LOCKED = 423;
/** A person types a PIN; ten a minute is generous. The lockout is the real bound. */
const REQUEST_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Asking to close the account (ADR-0003). Only ever the caller's own. An
 * operator carries it out after the seven days in which it can be withdrawn
 * (POST /v1/settings-requests/:id/withdraw); nothing here closes anything.
 * No logger here (S15): the body carries the PIN.
 */
@Controller("v1/account/deletion")
export class AccountDeletionController {
  constructor(
    private readonly closure: AccountClosureService,
    private readonly pin: PinService,
  ) {}

  /** What the app shows first: anything in the way, and what closing means. */
  @Get()
  async status(
    @CurrentPrincipal() principal: AppPrincipal,
  ): Promise<AccountDeletionView> {
    const status = await this.closure.status(principal.userId);
    const open = status.openRequest;
    return {
      request: open ? toSettingsRequestView(open) : null,
      completeBy: open ? closureDueBy(open.requestedAt).toISOString() : null,
      canRequest: status.blockers.length === 0,
      blockers: status.blockers,
      balance: status.balance,
      pinRequired: status.pinSet,
      hasAccount: status.hasAccount,
      notice: closureNotice(status.hasAccount),
    };
  }

  @Throttle(REQUEST_THROTTLE)
  @Post()
  async request(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: RequestAccountDeletionDto,
  ): Promise<AccountDeletionRequestedView> {
    // In the app's channel context, so the confirmation lands in the app chat.
    const result = await inApp(principal, () =>
      this.closure.request(principal.userId, {
        via: "app",
        reason: dto.reason?.trim() || undefined,
        authorize: (user) => this.checkPin(user, dto.pin),
      }),
    );
    if (result.kind === "blocked") throw blocked(result);
    return {
      request: toSettingsRequestView(result.request),
      completeBy: result.completeBy.toISOString(),
    };
  }

  /**
   * The PIN, when one is set, under the same counter and lockout as a payment.
   * Runs after every other check, so no guess is spent on a request that
   * would have been refused anyway.
   */
  private async checkPin(user: User, pin: string | undefined): Promise<void> {
    if (!user.pinHash) return;
    if (!pin) throw new BadRequestException({ error: "pin_required" });
    const verdict = await this.pin.verifyPin(user.id, pin);
    if (verdict.ok) return;
    if (verdict.lockedUntil) {
      throw new HttpException(
        { error: "pin_locked", lockedUntil: verdict.lockedUntil.toISOString() },
        HTTP_LOCKED,
      );
    }
    // 422, not sign-in's 401: on a signed-in route the app would read a 401 as
    // an expired session.
    throw new UnprocessableEntityException({
      error: "wrong_pin",
      message: verdict.reason,
    });
  }
}

function blocked(
  result: Extract<ClosureRequestResult, { kind: "blocked" }>,
): HttpException {
  switch (result.blocker) {
    case "request_open":
      return new ConflictException({
        error: "request_open",
        request: result.openRequest
          ? toSettingsRequestView(result.openRequest)
          : null,
      });
    case "payment_in_progress":
      return new ConflictException({ error: "payment_in_progress" });
    case "balance_not_zero":
      return new ConflictException({
        error: "balance_not_zero",
        balance: result.balance,
      });
    case "balance_unavailable":
      return new ServiceUnavailableException({ error: "balance_unavailable" });
  }
}
