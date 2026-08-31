export const BILL_PAYMENT_SURFACES = [
  "bill_payment_wizard",
  "data_bundle_wizard",
  "electricity_wizard",
] as const;

export type BillPaymentSurfaceKey = (typeof BILL_PAYMENT_SURFACES)[number];

export function isBillPaymentSurface(
  key?: string | null,
): key is BillPaymentSurfaceKey {
  return !!key && (BILL_PAYMENT_SURFACES as readonly string[]).includes(key);
}

export function moneyOutWizardSurface(key?: string | null): boolean {
  return key === "transfer_wizard" || isBillPaymentSurface(key);
}

/**
 * Product language for VAS — not a bank send. Checked before `pay` transfer
 * matching so "pay electricity" does not open send-money.
 */
export function inferBillSurfaceFromText(
  text: string,
): BillPaymentSurfaceKey | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  if (
    /\b(nepa|prepaid\s+meter|electricity|disco|ekedc|ikedc|buy (?:power|token)|pay (?:nepa|light|power))\b/i.test(
      t,
    ) ||
    /\b(meter\s+token|light\s+token)\b/i.test(t)
  ) {
    return "electricity_wizard";
  }

  if (/\b(buy data|data bundle|mobile data)\b/i.test(t)) {
    return "data_bundle_wizard";
  }

  if (/\b(airtime|recharge|top\s*up|buy credit)\b/i.test(t)) {
    return "bill_payment_wizard";
  }

  return null;
}

export function isBillPaymentUtterance(text: string): boolean {
  return inferBillSurfaceFromText(text) != null;
}

export function sanitizeBillHintFields(raw?: Record<string, unknown>): {
  msisdn?: string;
  telcoHint?: string;
  meter?: string;
  discoHint?: string;
} {
  const hints: {
    msisdn?: string;
    telcoHint?: string;
    meter?: string;
    discoHint?: string;
  } = {};
  if (!raw || typeof raw !== "object") return hints;

  if (typeof raw.msisdn === "string" || typeof raw.phone === "string") {
    const digits = String(raw.msisdn ?? raw.phone).replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) {
      hints.msisdn = digits;
    }
  }

  if (typeof raw.telco_hint === "string") {
    const telco = raw.telco_hint.trim().slice(0, 40);
    if (telco.length >= 2) hints.telcoHint = telco;
  }

  if (typeof raw.meter === "string") {
    const digits = raw.meter.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) {
      hints.meter = digits;
    }
  }

  if (typeof raw.disco_hint === "string") {
    const disco = raw.disco_hint.trim().slice(0, 60);
    if (disco.length >= 2) hints.discoHint = disco;
  }

  return hints;
}
