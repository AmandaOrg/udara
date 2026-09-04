/**
 * The one place that decides whether a short message means "stop this".
 *
 * There were three copies of this regex: a `BILL_CANCEL_WORDS` in the
 * bill-payment constants, a byte-identical private one in the transfer wizard,
 * and the weekly review importing the bill-prefixed one for something that has
 * nothing to do with bills. Widening one to accept "forget it" would silently
 * change what aborts a limit change, and leave the transfer wizard behind.
 */
export const CANCEL_WORDS = /^(cancel|stop|nevermind|never mind)$/i;

/** True when this whole message is the user asking to stop. */
export function isCancelWord(text: string): boolean {
  return CANCEL_WORDS.test(text.trim());
}
