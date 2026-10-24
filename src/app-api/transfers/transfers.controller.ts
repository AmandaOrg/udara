import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { NativeTransferService } from "./native-transfer.service";
import { IDEMPOTENCY_KEY } from "../payments.util";
import { AuthorizeTransferDto, CreateTransferDto } from "./transfers.dto";
import {
  AuthorizeView,
  ConfirmView,
  QuoteView,
  TransferView,
} from "./transfer.view";

/** A person types a PIN; ten a minute is generous. The lockout is the real bound. */
const AUTHORIZE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
/** Each quote is a row and, for a new recipient, a bank lookup. */
const QUOTE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Sending money from the app's own screens: quote, confirm, PIN, result.
 * Only ever the caller's own transfers. No logger here (S15): bodies carry
 * account numbers and the PIN.
 */
@Controller("v1/transfers")
export class TransfersController {
  constructor(private readonly native: NativeTransferService) {}

  /**
   * The quote. Idempotency-Key is required (S17): a retry after a dropped
   * connection returns the same transfer (200) instead of a second one.
   */
  @Throttle(QUOTE_THROTTLE)
  @Post()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async create(
    @CurrentPrincipal() principal: AppPrincipal,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteView> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException({ error: "idempotency_key_required" });
    }
    const { replayed, view } = await this.native.quote(principal, key, dto);
    res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return view;
  }

  @Get(":id")
  get(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<TransferView> {
    return this.native.get(principal, id);
  }

  /** Confirm tapped: the decision, and a PIN token when the PIN is next. */
  @Post(":id/confirm")
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ConfirmView> {
    return this.native.confirm(principal, id);
  }

  /** The PIN. Answered once the result is known, or known to be pending. */
  @Throttle(AUTHORIZE_THROTTLE)
  @Post(":id/authorize")
  @HttpCode(HttpStatus.OK)
  authorize(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AuthorizeTransferDto,
  ): Promise<AuthorizeView> {
    return this.native.authorize(principal, id, dto);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<TransferView> {
    return this.native.cancel(principal, id);
  }
}
