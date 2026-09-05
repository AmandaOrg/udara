/**
 * The catalog of UI surfaces the orchestrator can trigger. Each surface
 * has an eligibility predicate evaluated at prompt-build time — the model
 * only sees surfaces the user can actually reach right now, reducing the
 * output space and improving classification accuracy.
 *
 * Adding a new surface: register it here with a key, description, and
 * eligibility check. The orchestrator prompt, validator, and router
 * dispatch all key off `surface.key`.
 */

import { User } from "@prisma/client";
import { isPreAccountStage } from "../onboarding/onboarding.service";
import { SurfaceKind } from "./orchestrator.types";

export interface SurfaceDefinition {
  key: string;
  kind: SurfaceKind;
  /** Shown to the model — describes when to use this surface. */
  description: string;
  /** Machine-evaluated at prompt-build time; model never sees this. */
  isEligible: (user: User) => boolean;
}

export const SURFACE_REGISTRY: SurfaceDefinition[] = [
  {
    key: "balance_read",
    kind: "text",
    description:
      'Show current account balance. Use when user asks how much they have, their balance, what is in their account, "check my money", "how much do I have left" (account balance, not daily allowance).',
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "limits_read",
    kind: "text",
    description:
      'Show remaining daily/weekly allowance and spending-window status. Use when user asks about spending limits, allowance left, "what can I spend today", "daily limit", "how much can I still spend", or borrowing from tomorrow/future days.',
    isEligible: (u) => !isPreAccountStage(u.onboardingStage),
  },
  {
    key: "account_details",
    kind: "text",
    description:
      'Show account number and bank details. Use when user asks for their account number, bank info, "how do I fund my account", or Rubies details.',
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "bill_payment_wizard",
    kind: "wizard",
    description:
      "Start the buy-airtime wizard. Use when user clearly wants to buy airtime or top up a phone RIGHT NOW — any natural phrasing (airtime, recharge, top up, buy credit). Do NOT trigger for past purchases or casual mentions.",
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "data_bundle_wizard",
    kind: "wizard",
    description:
      "Start the buy-data wizard. Use when user clearly wants to buy a mobile data bundle RIGHT NOW. Do NOT trigger for past purchases or casual mentions.",
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "electricity_wizard",
    kind: "wizard",
    description:
      "Start prepaid electricity payment. Use when user wants to buy power/token for their meter NOW (Nepa, prepaid meter, electricity bill). Do NOT trigger for past payments.",
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "transfer_wizard",
    kind: "wizard",
    description:
      "Start the send-money wizard. Use when user clearly wants to send or transfer money RIGHT NOW — not airtime/data/electricity. Put amount, account_number, bank_name/bank_code, beneficiary_name (from live facts only), and label_hint into extracted_hints when present. Do NOT invent account numbers. Do NOT trigger for past transfers, casual mentions, or bill purchases.",
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "spending_menu",
    kind: "list",
    description:
      'Main menu with all options: balance, limits, account details, send money. Use when user says "help", "menu", "options", "what can you do", "what can I do here", or seems lost.',
    isEligible: (u) => !isPreAccountStage(u.onboardingStage),
  },
  {
    key: "pin_reset",
    kind: "text",
    description:
      "Start a PIN reset. Use when the user has forgotten their transfer PIN, wants to change it, says their PIN is locked or not working, or asks to reset/change their pin. Do NOT use for spending limits or window changes, which are a different thing entirely.",
    isEligible: (u) => !!u.rubiesAccountNumber,
  },
  {
    key: "settings_request",
    kind: "text",
    description:
      'File a request to change the rules or leave. Use when the user wants their spending window changed, their limits raised permanently, the override fees changed, or to stop/exit/quit Udara or "turn this off". Put settings_change_type (WINDOW_HOURS | OVERRIDE_FEES | EXIT_RESTRICTIONS | OTHER) and their reason in extracted_hints. This only FILES the request — it changes nothing, and the waiting period applies however it is phrased, so never imply it takes effect now. Do NOT use for a one-week limit tweak (that is the Sunday review) or a forgotten PIN (that is pin_reset).',
    isEligible: (u) => !isPreAccountStage(u.onboardingStage),
  },
  {
    key: "spend_summary",
    kind: "text",
    description:
      'Show weekly spending breakdown by category. Use when user asks where their money went, spending summary, "what did I spend on", or transaction history.',
    isEligible: (u) => !isPreAccountStage(u.onboardingStage),
  },
];

/** Returns only the surfaces the user is eligible for right now. */
export function getEligibleSurfaces(user: User): SurfaceDefinition[] {
  return SURFACE_REGISTRY.filter((s) => s.isEligible(user));
}

/** Compact string for the system prompt — one line per surface. */
export function formatSurfacesForPrompt(surfaces: SurfaceDefinition[]): string {
  if (surfaces.length === 0) {
    return "No surfaces available this turn. Use reply_only.";
  }
  const lines = surfaces.map((s) => `- ${s.key} (${s.kind}): ${s.description}`);
  return `Available surfaces you can trigger this turn:\n${lines.join("\n")}`;
}
