import { SettingsChangeType } from "@prisma/client";

/**
 * Deliberate, honestly-scoped stopgap: free-text intent classification is
 * the AI layer's job (Phase 3, deferred per user instruction). Without it,
 * there is no way to turn "send my landlord 20k" into a transfer — so
 * instead, onboarding-complete users get a small set of structured commands
 * that work today. Once the AI layer lands, replace the callers of these
 * functions in WhatsappRouterService with real classification —
 * TransferConfirmationService/ManagerConversationService's own APIs don't
 * need to change, only what decides to call them.
 */

export interface ParsedTransferCommand {
  amount: number;
  accountNumber: string;
  bankCode: string;
}

// "send 5000 to 0123456789 000005" — amount, then a 10-digit NUBAN, then a 6-digit CBN bank code.
const TRANSFER_COMMAND_RE =
  /^send\s+([\d,]+(?:\.\d+)?)\s+to\s+(\d{10})\s+(\d{6})$/i;

export function parseTransferCommand(
  text: string,
): ParsedTransferCommand | null {
  const match = text.trim().match(TRANSFER_COMMAND_RE);
  if (!match) return null;

  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return { amount, accountNumber: match[2], bankCode: match[3] };
}

export interface ParsedManagerCommand {
  type: SettingsChangeType;
  requestedChange: string;
}

const SETTINGS_CHANGE_TYPES = new Set(Object.values(SettingsChangeType));

// "manager EXIT_RESTRICTIONS I want more flexibility because ..."
const MANAGER_COMMAND_RE = /^manager\s+(\S+)\s+(.+)$/is;

export function parseManagerCommand(text: string): ParsedManagerCommand | null {
  const match = text.trim().match(MANAGER_COMMAND_RE);
  if (!match) return null;

  const type = match[1].toUpperCase();
  if (!SETTINGS_CHANGE_TYPES.has(type as SettingsChangeType)) return null;

  return { type: type as SettingsChangeType, requestedChange: match[2].trim() };
}

const SPEND_SUMMARY_KEYWORDS = ["spend", "spent", "summary"];

/** Keyword heuristic, not classification — deliberately permissive over precise. */
export function isSpendSummaryQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return SPEND_SUMMARY_KEYWORDS.some((kw) => lower.includes(kw));
}
