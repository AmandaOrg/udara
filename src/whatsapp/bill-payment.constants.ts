/** Deterministic airtime telco catalog (prod Rubies VAS codes). */
export const AIRTIME_TELCOS = [
  {
    billerCode: "MTN_AIRTIME",
    productCode: "MTN_AIRTIME_PREPAID",
    label: "MTN",
  },
  {
    billerCode: "AIRTEL_AIRTIME",
    productCode: "AIRTEL_AIRTIME_PREPAID",
    label: "Airtel",
  },
  {
    billerCode: "GLO_AIRTIME",
    productCode: "GLO_AIRTIME_PREPAID",
    label: "Glo",
  },
  {
    billerCode: "9MOBILE_AIRTIME",
    productCode: "9MOBILE_AIRTIME_PREPAID",
    label: "9mobile",
  },
] as const;

export const TELCO_BUTTON_PREFIX = "telco:";
export const DATA_TELCO_BUTTON_PREFIX = "data_telco:";
export const BUNDLE_BUTTON_PREFIX = "bundle:";
export const DISCO_BUTTON_PREFIX = "disco:";
export const CONFIRM_BILL_PREFIX = "confirm_bill:";
export const CANCEL_BILL_PREFIX = "cancel_bill:";

export const MIN_AIRTIME_AMOUNT = 50;
export const MAX_AIRTIME_AMOUNT = 50_000;

export const BILL_CANCEL_WORDS = /^(cancel|stop|nevermind|never mind)$/i;

export function findAirtimeTelco(billerCode: string) {
  return AIRTIME_TELCOS.find((t) => t.billerCode === billerCode);
}

/** Map spoken network names onto the closed airtime catalog. */
export function matchAirtimeTelcoHint(raw?: string) {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  if (/\b(mtn|m-?tn)\b/.test(t) || t === "mtn") {
    return findAirtimeTelco("MTN_AIRTIME");
  }
  if (/\bairtel\b/.test(t)) return findAirtimeTelco("AIRTEL_AIRTIME");
  if (/\bglo\b/.test(t)) return findAirtimeTelco("GLO_AIRTIME");
  if (/\b(9mobile|etisalat|nine\s*mobile)\b/.test(t)) {
    return findAirtimeTelco("9MOBILE_AIRTIME");
  }
  return AIRTIME_TELCOS.find((telco) => telco.label.toLowerCase() === t);
}

/** Normalize Nigerian MSISDN to 11-digit local form (070xxxxxxxx). */
export function normalizeMsisdn(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) return digits;
  if (digits.length === 13 && digits.startsWith("234")) {
    return `0${digits.slice(3)}`;
  }
  if (digits.length === 10) return `0${digits}`;
  return null;
}
