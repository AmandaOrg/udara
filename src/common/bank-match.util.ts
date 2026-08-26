export interface BankInfo {
  bankCode: string;
  bankName: string;
}

export type BankMatchResult =
  | { kind: 'none' }
  | { kind: 'single'; bank: BankInfo }
  | { kind: 'multiple'; banks: BankInfo[] }
  | { kind: 'too_many'; count: number };

/**
 * Resolves a bank query (name substring or 6-digit CBN code) against the
 * Rubies bank list. Shared by the transfer wizard text handler and prefill.
 */
export function matchBanks(query: string, banks: BankInfo[]): BankMatchResult {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { kind: 'none' };

  let matches: BankInfo[];
  if (/^\d{6}$/.test(normalized)) {
    matches = banks.filter((b) => b.bankCode === normalized);
  } else {
    matches = banks.filter((b) =>
      b.bankName.toLowerCase().includes(normalized),
    );
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'single', bank: matches[0] };
  if (matches.length > 10) return { kind: 'too_many', count: matches.length };
  return { kind: 'multiple', banks: matches };
}
