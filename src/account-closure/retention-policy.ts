/**
 * The numbers in ADR-0003 (docs/decisions/0003-account-closure-and-retention.md).
 * Read that before changing any of them: each one is a legal position, not a
 * tuning knob.
 */

/**
 * A closed account holder's identity, payment records and conversation are
 * kept this long after closure, then destroyed or irreversibly de-identified.
 *
 * Five years is the anti-money-laundering minimum (MLPPA 2022 s.8; CBN
 * AML/CFT/CPF Regulations 2022 regs 35-36). The sixth covers the period in
 * which a claim over a transaction or a tax assessment can still be raised
 * (GAID 2025 Art. 38(2)(d)). One date per account keeps the purge auditable.
 * A legal hold extends it (CBN reg 35(1)).
 */
export const RETENTION_YEARS_AFTER_CLOSURE = 6;

/**
 * An operator closes the account within this many days of the request: the
 * period GAID 2025 Schedule 9 gives a controller to act on a data subject's
 * demand. The request becomes eligible after the settings-change wait
 * (SETTINGS_CHANGE_MIN_DAYS, 7 by default), so this leaves ops the rest.
 */
export const CLOSURE_DUE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the closure must be done by, counted from the request. */
export function closureDueBy(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + CLOSURE_DUE_DAYS * DAY_MS);
}

/** Until when a closed account holder's records are kept. */
export function recordsKeptUntil(closedAt: Date): Date {
  const until = new Date(closedAt);
  until.setUTCFullYear(until.getUTCFullYear() + RETENTION_YEARS_AFTER_CLOSURE);
  return until;
}
