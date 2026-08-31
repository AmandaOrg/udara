import { RecipientLabel } from "@prisma/client";
import { parseNairaAmount } from "../common/naira-amount.util";
import {
  inferBillSurfaceFromText,
  isBillPaymentUtterance,
  sanitizeBillHintFields,
} from "./bill-hints.util";

const LABEL_HINTS: ReadonlySet<string> = new Set([
  "RENT",
  "FOOD",
  "VENDOR",
  "OTHER",
]);

/** Validated hints passed from the orchestrator into the transfer wizard. */
export interface TransferWizardHints {
  amount?: number;
  accountNumber?: string;
  bankCode?: string;
  bankName?: string;
  labelHint?: RecipientLabel;
  /** Saved-beneficiary lookup only — code resolves to account/bank, never the model. */
  beneficiaryName?: string;
  /** User's stated why, stored on the spend-check session only. */
  spendReason?: string;
  /** Typed purpose when label is OTHER. */
  purposeNote?: string;
  /** Spend-check: which wizard to open after they proceed. */
  pendingSurface?: string;
  msisdn?: string;
  telcoHint?: string;
  meter?: string;
  discoHint?: string;
}

/**
 * Sanitizes raw LLM extracted_hints for transfer_wizard. Rejects malformed
 * or implausible values rather than guessing — partial valid hints are kept.
 */
export function sanitizeTransferHints(
  raw?: Record<string, unknown>,
): TransferWizardHints {
  const hints: TransferWizardHints = {};
  if (!raw || typeof raw !== "object") return hints;

  const amount = parseNairaAmount(raw.amount);
  if (amount != null) {
    hints.amount = amount;
  }

  if (typeof raw.account_number === "string") {
    const digits = raw.account_number.replace(/\D/g, "");
    if (digits.length === 10) {
      hints.accountNumber = digits;
    }
  }

  if (typeof raw.bank_code === "string") {
    const code = raw.bank_code.trim();
    if (/^\d{6}$/.test(code)) {
      hints.bankCode = code;
    }
  }

  if (typeof raw.bank_name === "string") {
    const name = raw.bank_name.trim();
    if (name.length > 0 && name.length <= 100) {
      hints.bankName = name;
    }
  }

  if (typeof raw.label_hint === "string" && LABEL_HINTS.has(raw.label_hint)) {
    hints.labelHint = raw.label_hint as RecipientLabel;
  }

  if (typeof raw.beneficiary_name === "string") {
    const name = raw.beneficiary_name.trim().slice(0, 50);
    if (name.length >= 2) {
      hints.beneficiaryName = name;
    }
  }

  if (typeof raw.purpose_note === "string") {
    const note = raw.purpose_note.trim().slice(0, 200);
    if (note.length >= 2) {
      hints.purposeNote = note;
    }
  }

  if (typeof raw.pending_surface === "string") {
    const surface = raw.pending_surface.trim();
    if (surface.length > 0 && surface.length <= 64) {
      hints.pendingSurface = surface;
    }
  }

  Object.assign(hints, sanitizeBillHintFields(raw));

  return hints;
}

/** Enough to start the wizard without waiting for "go ahead". */
export function hasActionableTransferHints(
  hints: TransferWizardHints,
): boolean {
  if (hints.amount == null || hints.amount <= 0) return false;
  return !!(
    hints.accountNumber ||
    hints.bankName ||
    hints.bankCode ||
    hints.beneficiaryName
  );
}

/**
 * Thanks / "you already sent it" — never launch or continue a transfer
 * from this utterance, even if the model still has leftover send hints.
 */
export function isClosedTransferUtterance(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/^(thanks|thank you|thx|ty|thank you so much)[\s!.]*$/i.test(t)) {
    return true;
  }
  // "I already sent the account" is mid-wizard, not a completed-send ack.
  return (
    /\byou(?:'ve| have) (?:already )?(?:done|sent|transferred)\b/i.test(t) ||
    /\byou already (?:sent|did|transferred|done)\b/i.test(t) ||
    /\balready (?:transferred|done the transfers?)\b/i.test(t)
  );
}

/**
 * True when THIS message is asking to send money now — not thanks,
 * not "you already sent it". Used only to promote reply_only → wizard.
 * "yes"/"ok" are not promotions; a high-confidence show_surface still runs
 * unless {@link isClosedTransferUtterance} applies.
 */
export function isActiveSendUtterance(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (isClosedTransferUtterance(t)) return false;
  if (isBillPaymentUtterance(t)) return false;
  if (
    /^(ok|okay|cool|great|perfect|done|got it|please|yes|yeah|yep)[\s!.]*$/i.test(
      t,
    )
  ) {
    return false;
  }
  return (
    /\b(send|sending|pay\b|paying|make a transfer|want to transfer|lets? (make a )?(transf|trasf)|transfer of|transfer \d)/i.test(
      t,
    ) ||
    (/\btra[ns]+fer/i.test(t) && /\d/.test(t))
  );
}

/**
 * Skip-check only: they already said what the money is for.
 * Not a transfer parser and not a complete category list.
 */
export function hasStatedSpendPurpose(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /\b(rent|landlord|food|grocer|chop\b|vendor|school|fees?\b|light bill|electric|data\b|airtime|fuel|transport|hospital|medicine|upkeep|dstv|gotv)\b/i.test(
    t,
  );
}

export function isSpendCheckAbortUtterance(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /^(never mind|dont send|don't send|forget it|cancel|not sending|don't bother)[\s!.]*$/i.test(
    t,
  );
}

/** After we asked why: purpose, insist, or a short go-ahead. */
export function isSpendCheckProceedUtterance(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (isSpendCheckAbortUtterance(t) || isClosedTransferUtterance(t)) {
    return false;
  }
  if (hasStatedSpendPurpose(t)) return true;
  if (
    /\b(just send|send it anyway|go ahead|still (want to )?send|it's for|its for|because )\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return /^(ok|okay|yes|yeah|yep|please)[\s!.]*$/i.test(t);
}

export function shouldPauseForSpendCheck(text: string): boolean {
  return isActiveSendUtterance(text) || isBillPaymentUtterance(text);
}

export function pendingSurfaceForUtterance(text: string): string | undefined {
  return (
    inferBillSurfaceFromText(text) ??
    (isActiveSendUtterance(text) ? "transfer_wizard" : undefined)
  );
}

export const SPEND_CHECK_FALLBACK_MESSAGE =
  "having room today isn't the same as this being a smart send. what's it actually for, and do you need it right now?";

export function transferHintsToRaw(
  hints: TransferWizardHints,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (hints.amount != null) raw.amount = hints.amount;
  if (hints.accountNumber) raw.account_number = hints.accountNumber;
  if (hints.bankCode) raw.bank_code = hints.bankCode;
  if (hints.bankName) raw.bank_name = hints.bankName;
  if (hints.labelHint) raw.label_hint = hints.labelHint;
  if (hints.beneficiaryName) raw.beneficiary_name = hints.beneficiaryName;
  if (hints.purposeNote) raw.purpose_note = hints.purposeNote;
  if (hints.pendingSurface) raw.pending_surface = hints.pendingSurface;
  if (hints.msisdn) raw.msisdn = hints.msisdn;
  if (hints.telcoHint) raw.telco_hint = hints.telcoHint;
  if (hints.meter) raw.meter = hints.meter;
  if (hints.discoHint) raw.disco_hint = hints.discoHint;
  return raw;
}

export function transferHintsFromContext(raw: unknown): TransferWizardHints {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const hints = sanitizeTransferHints({
    amount: o.amount,
    account_number: o.accountNumber ?? o.account_number,
    bank_code: o.bankCode ?? o.bank_code,
    bank_name: o.bankName ?? o.bank_name,
    label_hint: o.labelHint ?? o.label_hint,
    beneficiary_name: o.beneficiaryName ?? o.beneficiary_name,
    purpose_note: o.purposeNote ?? o.purpose_note,
    pending_surface: o.pendingSurface ?? o.pending_surface,
    msisdn: o.msisdn,
    telco_hint: o.telcoHint ?? o.telco_hint,
    meter: o.meter,
    disco_hint: o.discoHint ?? o.disco_hint,
  });
  if (typeof o.spendReason === "string") {
    hints.spendReason = o.spendReason.slice(0, 200);
  }
  return hints;
}

export function isWeakSpendCheckMessage(message: string): boolean {
  const t = message.trim().toLowerCase();
  if (!t) return true;
  if (
    /\?|what(?:'s| is) it for|why |need or want|actually for|smart send/.test(t)
  ) {
    return false;
  }
  return t.length < 48;
}
