/**
 * Parse user-stated naira amounts. Hints and drafts always store a number.
 * Does not guess: returns null when the utterance is not a clear amount.
 */

const WORD_UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export function parseNairaAmount(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;

  const t = raw
    .trim()
    .toLowerCase()
    .replace(/₦/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  const kMatch = t.match(/^(\d+(?:\.\d+)?)\s*k(?:aira)?$/i);
  if (kMatch) {
    const n = Number(kMatch[1]) * 1000;
    return n > 0 && Number.isFinite(n) ? n : null;
  }

  const thousandMatch = t.match(/^(\d+(?:\.\d+)?)\s*(?:thousand|k)\b/);
  if (thousandMatch && /^[\d.\s]+(?:thousand|k)$/.test(t)) {
    const n = Number(thousandMatch[1]) * 1000;
    return n > 0 && Number.isFinite(n) ? n : null;
  }

  const plain = t.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) {
    const n = Number(plain[1]);
    return n > 0 && Number.isFinite(n) ? n : null;
  }

  const fromWords = parseWordAmount(t);
  if (fromWords != null) return fromWords;

  return null;
}

function parseWordAmount(t: string): number | null {
  const thousand = /\s+thousand$/.test(t);
  const kSuffix = /\s+k$/.test(t);
  const core = t.replace(/\s+(thousand|k)$/, "").trim();
  if (!core) return null;

  const parts = core.split(/[\s-]+/).filter(Boolean);
  let sum = 0;
  for (const p of parts) {
    if (p === "and") continue;
    const n = WORD_UNITS[p];
    if (n == null) return null;
    sum += n;
  }
  if (sum <= 0) return null;
  if (thousand || kSuffix) sum *= 1000;
  return sum;
}
