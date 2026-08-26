import { RecipientLabel } from '@prisma/client';

const LABEL_HINTS: ReadonlySet<string> = new Set([
  'RENT',
  'FOOD',
  'VENDOR',
  'OTHER',
]);

/** Validated hints passed from the orchestrator into the transfer wizard. */
export interface TransferWizardHints {
  amount?: number;
  accountNumber?: string;
  bankCode?: string;
  bankName?: string;
  labelHint?: RecipientLabel;
}

/**
 * Sanitizes raw LLM extracted_hints for transfer_wizard. Rejects malformed
 * or implausible values rather than guessing — partial valid hints are kept.
 */
export function sanitizeTransferHints(
  raw?: Record<string, unknown>,
): TransferWizardHints {
  const hints: TransferWizardHints = {};
  if (!raw || typeof raw !== 'object') return hints;

  const amount = Number(raw.amount);
  if (Number.isFinite(amount) && amount > 0) {
    hints.amount = amount;
  }

  if (typeof raw.account_number === 'string') {
    const digits = raw.account_number.replace(/\D/g, '');
    if (digits.length === 10) {
      hints.accountNumber = digits;
    }
  }

  if (typeof raw.bank_code === 'string') {
    const code = raw.bank_code.trim();
    if (/^\d{6}$/.test(code)) {
      hints.bankCode = code;
    }
  }

  if (typeof raw.bank_name === 'string') {
    const name = raw.bank_name.trim();
    if (name.length > 0 && name.length <= 100) {
      hints.bankName = name;
    }
  }

  if (
    typeof raw.label_hint === 'string' &&
    LABEL_HINTS.has(raw.label_hint)
  ) {
    hints.labelHint = raw.label_hint as RecipientLabel;
  }

  return hints;
}

/** Enough to start the wizard without waiting for "go ahead". */
export function hasActionableTransferHints(
  hints: TransferWizardHints,
): boolean {
  if (hints.amount == null || hints.amount <= 0) return false;
  return !!(hints.accountNumber || hints.bankName || hints.bankCode);
}
