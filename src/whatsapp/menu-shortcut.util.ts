/**
 * Tiny exact-ask shortcut so "what else can you do?" never waits on the LLM.
 * Not a language parser — only tight whole-message / short-phrase matches.
 */
import {
  MENU_ACCOUNT,
  MENU_AIRTIME,
  MENU_BALANCE,
  MENU_DATA,
  MENU_ELECTRICITY,
  MENU_LIMITS,
  MENU_TRANSFER,
} from "./account-actions.service";

function normalizeAsk(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const EXACT_MENU_ASKS = new Set([
  "help",
  "menu",
  "options",
  "what else can you do",
  "what can you do",
  "what can you do here",
  "what can i do",
  "what can i do here",
  "what are my options",
]);

export function isMenuShortcut(text: string): boolean {
  const t = normalizeAsk(text);
  if (!t) return false;
  if (EXACT_MENU_ASKS.has(t)) return true;
  if (/\bthings you can do\b/.test(t) || /\btell me what you can\b/.test(t)) {
    return true;
  }
  if (/\bwhat(?: else)? can (?:you|i) do\b/.test(t)) {
    return !/\b(send|transfer|airtime|data|electricity|nepa)\b/.test(t);
  }
  return false;
}

/** When a list tap arrives as plain text (row title), skip the LLM. */
export function menuPayloadFromUtterance(text: string): string | null {
  const t = normalizeAsk(text)
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  switch (t) {
    case "check balance":
      return MENU_BALANCE;
    case "spending limits":
      return MENU_LIMITS;
    case "account details":
      return MENU_ACCOUNT;
    case "send money":
      return MENU_TRANSFER;
    case "buy airtime":
      return MENU_AIRTIME;
    case "buy data":
      return MENU_DATA;
    case "pay electricity":
      return MENU_ELECTRICITY;
    default:
      return null;
  }
}
