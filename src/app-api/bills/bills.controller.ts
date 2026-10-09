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
import {
  AIRTIME_TELCOS,
  MAX_AIRTIME_AMOUNT,
  MIN_AIRTIME_AMOUNT,
} from "../../whatsapp/bill-payment.constants";
import {
  bundlesForTelco,
  DATA_TELCOS,
  ELECTRICITY_DISCOS,
} from "../../whatsapp/bill-payment-catalog";
import { CurrentPrincipal } from "../current-principal.decorator";
import { IDEMPOTENCY_KEY } from "../payments.util";
import { NativeBillService } from "./native-bill.service";
import { AuthorizeBillDto, CreateBillDto } from "./bills.dto";
import { BillCatalogView } from "./bills.view";
import {
  BillAuthorizeView,
  BillConfirmView,
  BillPaymentView,
  BillQuoteView,
} from "./bill-payment.view";

/**
 * What can be bought, from the same catalog the WhatsApp wizards offer.
 * Electricity takes the same amount bounds as airtime there.
 */
const CATALOG: BillCatalogView = {
  airtime: {
    networks: AIRTIME_TELCOS.map((t) => ({ ...t })),
    minAmount: MIN_AIRTIME_AMOUNT,
    maxAmount: MAX_AIRTIME_AMOUNT,
  },
  data: {
    networks: DATA_TELCOS.map((t) => ({
      billerCode: t.billerCode,
      label: t.label,
      bundles: bundlesForTelco(t.billerCode).map((b) => ({ ...b })),
    })),
  },
  electricity: {
    companies: ELECTRICITY_DISCOS.map((d) => ({ ...d })),
    minAmount: MIN_AIRTIME_AMOUNT,
    maxAmount: MAX_AIRTIME_AMOUNT,
  },
};

/** A person types a PIN; ten a minute is generous. The lockout is the real bound. */
const AUTHORIZE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
/** Each quote is a row and, for electricity, a meter lookup. */
const QUOTE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Airtime, data and prepaid electricity from the app's own screens: the
 * catalog, then quote, confirm, PIN, result. Only ever the caller's own
 * purchases. No logger here (S15): bodies carry phone and meter numbers and
 * the PIN.
 *
 * `catalog` is declared before `:id`. Express matches in registration order,
 * so the catalog is never read as a purchase id.
 */
@Controller("v1/bills")
export class BillsController {
  constructor(private readonly native: NativeBillService) {}

  @Get("catalog")
  catalog(): BillCatalogView {
    return CATALOG;
  }

  /**
   * The quote. Idempotency-Key is required (S17): a retry after a dropped
   * connection returns the same purchase (200) instead of a second one.
   */
  @Throttle(QUOTE_THROTTLE)
  @Post()
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async create(
    @CurrentPrincipal() principal: AppPrincipal,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: CreateBillDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillQuoteView> {
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
  ): Promise<BillPaymentView> {
    return this.native.get(principal, id);
  }

  /** Confirm tapped: the decision, and a PIN token when the PIN is next. */
  @Post(":id/confirm")
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<BillConfirmView> {
    return this.native.confirm(principal, id);
  }

  /** The PIN. Answered once the result is known, or known to be pending. */
  @Throttle(AUTHORIZE_THROTTLE)
  @Post(":id/authorize")
  @HttpCode(HttpStatus.OK)
  authorize(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AuthorizeBillDto,
  ): Promise<BillAuthorizeView> {
    return this.native.authorize(principal, id, dto);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<BillPaymentView> {
    return this.native.cancel(principal, id);
  }
}
