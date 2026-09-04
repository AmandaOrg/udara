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

/**
 * A forgiving parser for one specific question: "what daily limit do you want?"
 *
 * `parseNairaAmount` above is deliberately strict, and must stay that way — it
 * decides what a *wizard* does with free text, where guessing an amount out of
 * prose would be a way to move money the user did not ask to move. Its own spec
 * pins that contract.
 *
 * The weekly review is the opposite situation. The user has just tapped
 * "Adjust limits" and been asked for a number, so a number is exactly what they
 * are giving. Rejecting "5000 naira", "make it 5k" or a voice note transcribed
 * as "Five thousand." meant silently discarding an answer to a question we
 * asked, which is worse than reading it generously.
 *
 * Only used where the user has already been asked for an amount.
 */
export function parseLimitAnswer(raw: unknown): number | null {
  if (typeof raw !== "string") return parseNairaAmount(raw);

  const cleaned = raw
    .toLowerCase()
    .trim()
    // Leading intent: "make it 5k", "let's do 5000", "i want 5000"
    .replace(/^(make it|lets do|let's do|i want|do|set it to|set|use)\s+/, "")
    // Currency, written any of the ways people write it
    .replace(/(₦|\bngn\b|\bnaira\b|\bbucks\b)/g, " ")
    // Per-day suffixes, including "/day"
    .replace(/\s*(\/|per\s+|a\s+)?\s*(day|daily)\b/g, " ")
    .replace(/\bplease\b|\babeg\b|\bpls\b/g, " ")
    // Trailing punctuation, which is what smart-formatted transcripts add
    .replace(/[.!?,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return parseNairaAmount(cleaned);
}
