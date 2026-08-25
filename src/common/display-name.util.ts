/**
 * Display-name helpers for user-facing copy. Lowercase Udara voice applies to
 * Udara's own sentences — people's names should be capitalized correctly.
 */

function capitalizeWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Title-case the first token of a full name (e.g. "ada lovelace" → "Ada"). */
export function formatDisplayFirstName(
  fullName: string | null | undefined,
): string | null {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "there") return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first) return null;
  return capitalizeWord(first);
}

/** Fallback when no name is on file — keeps onboarding copy working. */
export function displayFirstNameOrThere(
  fullName: string | null | undefined,
): string {
  return formatDisplayFirstName(fullName) ?? "there";
}
