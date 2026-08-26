import { RecipientLabel } from '@prisma/client';
import { TransferWizardHints } from '../orchestrator/transfer-hints.util';

/** Common Nigerian bank / fintech names for regex extraction (no API needed). */
const BANK_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bopay\b/i, name: 'opay' },
  { pattern: /\bpalmpay\b/i, name: 'palmpay' },
  { pattern: /\bmoniepoint\b/i, name: 'moniepoint' },
  { pattern: /\bkuda\b/i, name: 'kuda' },
  { pattern: /\bgtbank\b|\bgt bank\b/i, name: 'gtbank' },
  { pattern: /\baccess bank\b|\baccess\b/i, name: 'access' },
  { pattern: /\bzenith\b/i, name: 'zenith' },
  { pattern: /\buba\b/i, name: 'uba' },
  { pattern: /\bfirst bank\b|\bfbn\b/i, name: 'first bank' },
  { pattern: /\bstanbic\b/i, name: 'stanbic' },
  { pattern: /\bfidelity\b/i, name: 'fidelity' },
  { pattern: /\bunion bank\b/i, name: 'union' },
  { pattern: /\bsterling\b/i, name: 'sterling' },
  { pattern: /\bwema\b/i, name: 'wema' },
  { pattern: /\bfcmb\b/i, name: 'fcmb' },
];

const LABEL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: RecipientLabel }> =
  [
    { pattern: /\b(rent|landlord)\b/i, label: 'RENT' },
    { pattern: /\bfood\b/i, label: 'FOOD' },
    { pattern: /\bvendor\b/i, label: 'VENDOR' },
  ];

const TRANSFER_INTENT_RE =
  /\b(send|transfer|pay)\b.*\b(money|cash|account|\d{10})\b|\b(send|transfer)\s+(money|to\b)|\b(i\s+)?(need\s+to\s+|want\s+to\s+|wanna\s+)?(send|transfer|pay)\b|\d{10}\b.*\b(opay|bank|gtbank|access|zenith|kuda)\b/i;

/**
 * Deterministic extraction from free text — no LLM. Used as a fast path and
 * as a fallback when the orchestrator times out or the user opens the menu
 * after already stating transfer details in chat.
 */
export function extractTransferHintsFromText(
  text: string,
): TransferWizardHints {
  const hints: TransferWizardHints = {};
  const trimmed = text.trim();
  if (!trimmed) return hints;

  const accountNearKeyword = trimmed.match(
    /account\s*(?:number|no\.?)?\s*[:\-]?\s*(\d[\d\s\-]{8,12}\d)/i,
  );
  const anyAccount = trimmed.match(/\b(\d{10})\b/);
  const accountRaw = accountNearKeyword?.[1] ?? anyAccount?.[1];
  if (accountRaw) {
    const digits = accountRaw.replace(/\D/g, '');
    if (digits.length === 10) {
      hints.accountNumber = digits;
    }
  }

  for (const { pattern, name } of BANK_NAME_PATTERNS) {
    if (pattern.test(trimmed)) {
      hints.bankName = name;
      break;
    }
  }

  const bankCodeMatch = trimmed.match(/\b(\d{6})\b/);
  if (bankCodeMatch && !hints.accountNumber?.includes(bankCodeMatch[1])) {
    hints.bankCode = bankCodeMatch[1];
  }

  const sendAmount = trimmed.match(
    /\b(?:send|transfer|pay)\s+(?:₦|n|ngn)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?\b/i,
  );
  const suffixK = trimmed.match(/\b([\d,]+(?:\.\d+)?)\s*(k|thousand)\b/i);
  const nairaAmount = trimmed.match(/₦\s*([\d,]+(?:\.\d+)?)/i);

  const amountMatch = sendAmount ?? suffixK ?? nairaAmount;
  if (amountMatch) {
    let amount = Number(amountMatch[1].replace(/,/g, ''));
    if (
      amountMatch[2] &&
      /k|thousand/i.test(amountMatch[2]) &&
      amount < 1000
    ) {
      amount *= 1000;
    }
    if (Number.isFinite(amount) && amount > 0) {
      hints.amount = amount;
    }
  } else if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(trimmed)) {
    const amount = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0) {
      hints.amount = amount;
    }
  }

  for (const { pattern, label } of LABEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      hints.labelHint = label;
      break;
    }
  }

  return hints;
}

export function looksLikeTransferIntent(text: string): boolean {
  return TRANSFER_INTENT_RE.test(text.trim());
}

/** Later arguments override earlier ones — explicit wizard input beats history. */
export function mergeTransferHints(
  ...parts: Array<TransferWizardHints | undefined>
): TransferWizardHints {
  const merged: TransferWizardHints = {};
  for (const part of parts) {
    if (!part) continue;
    if (part.amount !== undefined) merged.amount = part.amount;
    if (part.accountNumber) merged.accountNumber = part.accountNumber;
    if (part.bankCode) merged.bankCode = part.bankCode;
    if (part.bankName) merged.bankName = part.bankName;
    if (part.labelHint) merged.labelHint = part.labelHint;
  }
  return merged;
}

export function hasTransferHints(hints: TransferWizardHints): boolean {
  return !!(
    hints.amount ||
    hints.accountNumber ||
    hints.bankCode ||
    hints.bankName ||
    hints.labelHint
  );
}
