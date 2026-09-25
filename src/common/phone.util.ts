const NIGERIA = "234";

/**
 * The canonical form of `User.phoneNumber`: the international number as
 * digits, no "+". It is exactly the shape Meta sends as a WhatsApp sender id
 * (e.g. "2348012345678"), so a WhatsApp id needs no conversion. Using one
 * form everywhere is what lets an app sign-up and the same number messaging
 * on WhatsApp resolve to one User.
 *
 * For numbers people type. Local forms are read as Nigerian, since that is
 * who types them here: "0801 234 5678" and "8012345678" both become
 * "2348012345678". Returns null for anything that cannot be a phone number.
 */
export function normalizePhoneNumber(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  let digits: string;
  if (compact.startsWith("+")) {
    digits = compact.slice(1);
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
  } else if (/^0[789]\d{9}$/.test(compact)) {
    digits = NIGERIA + compact.slice(1);
  } else if (/^[789]\d{9}$/.test(compact)) {
    digits = NIGERIA + compact;
  } else {
    digits = compact;
  }

  // "+234 0801..." keeps the domestic trunk zero after the country code.
  if (/^2340[789]\d{9}$/.test(digits)) {
    digits = NIGERIA + digits.slice(4);
  }

  // E.164 allows at most 15 digits; below 8 is not a reachable number.
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** A Nigerian mobile number in canonical form: 234, then 10 digits starting 7, 8 or 9. */
export function isNigerianMobile(phoneNumber: string): boolean {
  return /^234[789]\d{9}$/.test(phoneNumber);
}
