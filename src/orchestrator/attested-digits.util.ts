/**
 * Digits the model proposes are only usable if the *user* supplied them.
 *
 * The hint sanitisers check shape — ten digits for an account number, ten to
 * thirteen for a phone or meter — but shape is not provenance. A model can emit
 * a correctly shaped account number it invented, or worse, one it read out of a
 * forwarded scam screenshot, and that number would flow into the transfer
 * wizard, through name enquiry, and onto a confirm screen. Confirm and PIN are
 * then the only things standing in the way, and people tap Confirm.
 *
 * So digits are matched against a corpus of what the user actually said. The one
 * deliberate exception is a photo the user sent *this turn*: reading a payee's
 * account number off an image is a supported feature, and those digits by
 * definition appear nowhere in the text.
 */

/** Every run of 6+ digits in a string, with separators stripped. */
function digitRuns(text: string): string[] {
  const runs: string[] = [];
  // Tolerate the ways people space account numbers: "0123 456 789",
  // "0123-456-789". Collapse to bare digits before comparing.
  const collapsed = text.replace(/[\s\-.]/g, "");
  for (const match of collapsed.matchAll(/\d{6,}/g)) {
    runs.push(match[0]);
  }
  return runs;
}

/**
 * Builds the set of digit strings the user is known to have supplied.
 * Substrings count: a user who typed a 13-digit meter number has also
 * "supplied" the 11-digit reading of it that a model might echo back.
 */
export function buildAttestedDigits(sources: (string | undefined | null)[]): string {
  return sources
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => digitRuns(s).join(" "))
    .join(" ");
}

/**
 * True when these digits appear in what the user supplied.
 *
 * `allowUnattested` is the visible-photo escape hatch described above — the
 * caller decides, because only it knows whether an image was actually sent to
 * the model this turn.
 */
export function isAttested(
  digits: string | undefined,
  attested: string,
  allowUnattested = false,
): boolean {
  if (!digits) return true; // nothing to check
  if (allowUnattested) return true;
  return attested.includes(digits);
}
