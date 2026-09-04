import { REDACTED } from "./sensitive-fields.util";

/**
 * Removes secrets a user typed as an ordinary chat message.
 *
 * `sensitive-fields.util.ts` redacts by *field name*, which covers the WhatsApp
 * Flow path completely. It cannot help when someone types their PIN or BVN into
 * the chat — which happens, especially when a Flow fails to open and the user
 * improvises. That text was then stored verbatim in `WhatsappMessage.textBody`,
 * copied into `ConversationSession.messages`, and sent to the model.
 *
 * **Deliberately narrow.** The obvious rule — redact any 11-digit run, since
 * that is a BVN or NIN — would also destroy every Nigerian mobile number and
 * break airtime and data purchases outright. So this only matches digits that
 * are *labelled* as a secret by the surrounding words. A user who types a bare
 * 11-digit number is buying airtime far more often than they are volunteering a
 * BVN, and guessing wrong in that direction breaks the product.
 */

/** "my bvn is 12345678901", "nin: 12345678901" — 11 digits, labelled. */
const LABELLED_ID = /\b(bvn|nin)\b([^0-9]{0,20})(\d{11})\b/gi;

/** "pin 1234", "my pin is 123456", "otp: 123456" — 4 to 6 digits, labelled. */
const LABELLED_SECRET = /\b(pin|otp|passcode)\b([^0-9]{0,20})(\d{4,6})\b/gi;

/**
 * Returns the text with labelled secrets replaced, leaving everything else —
 * including bare phone numbers and account numbers — untouched.
 */
export function scrubFreeTextSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(LABELLED_ID, (_m, label, gap) => `${label}${gap}${REDACTED}`)
    .replace(LABELLED_SECRET, (_m, label, gap) => `${label}${gap}${REDACTED}`);
}

/** True when scrubbing would change the text — useful for logging that it happened. */
export function containsLabelledSecret(text: string): boolean {
  return scrubFreeTextSecrets(text) !== text;
}
