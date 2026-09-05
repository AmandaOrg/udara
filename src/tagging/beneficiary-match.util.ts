import { Recipient } from "@prisma/client";

/**
 * Match saved recipients by nickname or account name substring.
 * Exact nickname wins; otherwise unique accountName substring match.
 */
export function matchSavedBeneficiaries(
  recipients: Recipient[],
  query: string,
): Recipient[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const byNickname = recipients.filter(
    (r) => r.nickname?.trim().toLowerCase() === q,
  );
  if (byNickname.length === 1) return byNickname;
  if (byNickname.length > 1) return byNickname;

  const byName = recipients.filter((r) => {
    const name = r.accountName?.trim().toLowerCase();
    return name ? name.includes(q) : false;
  });
  if (byName.length === 1) return byName;

  return [];
}

export function findAmbiguousBeneficiaryMatches(
  recipients: Recipient[],
  query: string,
): Recipient[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const byNickname = recipients.filter(
    (r) => r.nickname?.trim().toLowerCase() === q,
  );
  if (byNickname.length > 1) return byNickname;

  const byName = recipients.filter((r) => {
    const name = r.accountName?.trim().toLowerCase();
    return name ? name.includes(q) : false;
  });
  return byName.length > 1 ? byName : [];
}
