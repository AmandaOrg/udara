import { Controller, Get } from "@nestjs/common";
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
import { BillCatalogView } from "./bills.view";

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

@Controller("v1/bills")
export class BillsController {
  @Get("catalog")
  catalog(): BillCatalogView {
    return CATALOG;
  }
}
