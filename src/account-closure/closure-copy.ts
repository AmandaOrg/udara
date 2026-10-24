/**
 * What Udara tells someone closing their account, in the chat and by email
 * alike. The wording is the spec's (docs/specs/MOBILE_APP_SPEC.md, P9) and
 * states ADR-0003's retention period, so it lives in one place: the app shows
 * `closureNotice` before asking, and the same sentences are sent afterwards.
 */

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: "Africa/Lagos",
  day: "numeric",
  month: "long",
  year: "numeric",
};

/** "16 october 2026", in Lagos time. */
export function formatClosureDate(date: Date): string {
  return date.toLocaleDateString("en-NG", DATE_FORMAT).toLowerCase();
}

/** RETENTION_YEARS_AFTER_CLOSURE in words; a test keeps the two in step. */
export const RETENTION_PERIOD_WORDS = "six years";

/** What the app shows before asking for the PIN. */
export function closureNotice(hasAccount: boolean): string {
  return hasAccount
    ? `we'll close your udara account and delete your plan, goals, saved recipients and settings. nigerian law requires us to keep your identity details, payment history and our messages for ${RETENTION_PERIOD_WORDS} after the account closes. we keep them for that alone, then delete them. rubies microfinance bank, which holds your account, keeps its own records too.`
    : "we'll close your udara account and delete everything we hold about you.";
}

/** Sent once the request is filed, in the chat and by email. */
export function closureRequestedText(params: {
  eligibleAt: Date;
  completeBy: Date;
  /** Filed by the user in the app, or by ops for someone who asked another way. */
  via: "app" | "ops";
}): string {
  const withdraw =
    params.via === "app"
      ? "until then you can withdraw it in the app, under settings."
      : "if you change your mind before then, reply here and we'll stop it.";
  return [
    `your request to close your udara account is in. it can be closed from ${formatClosureDate(params.eligibleAt)}, and we'll have done it by ${formatClosureDate(params.completeBy)}.`,
    withdraw,
    "keep your balance at zero until it's done.",
  ].join(" ");
}

/** The last thing Udara sends, just before the account is closed. */
export function accountClosedText(recordsKept: boolean): string {
  return recordsKept
    ? `your udara account is closed and you've been signed out everywhere. as nigerian law requires, we're keeping your identity details, payment history and our messages for ${RETENTION_PERIOD_WORDS}, for that purpose alone; everything else has been deleted. we're asking rubies microfinance bank, which holds your account, to close it too. don't let anyone send money to your old account number.`
    : "your udara account is closed and everything we held about you has been deleted.";
}

/** When ops cannot close it yet: a hold, for example. */
export function closureDeclinedText(reason: string): string {
  const because = reason.trim().replace(/[.\s]+$/, "");
  return `we can't close your udara account yet. ${because}. we'll be in touch.`;
}
