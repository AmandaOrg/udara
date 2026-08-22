import { JsonSchemaToolDef, LlmMessage } from "../llm.types";

/**
 * Classifies a post-onboarding free-text message against the four
 * deterministic menu actions (account-actions.service.ts's sendMainMenu),
 * so IntentRouterService can route to the real handler instead of letting
 * KeduChatService's ungrounded persona chat guess/hallucinate an answer
 * (e.g. inventing a balance). See intent-router.service.ts for the caller.
 *
 * Deliberately narrow scope: this is ONLY for read-only status checks and
 * initiating a transfer. Anything about *changing* something — limits,
 * window hours, exiting restrictions, any settings/escalation request — is
 * explicitly excluded below and must classify NONE, so it keeps falling
 * through to general chat / the manager command exactly as it does today.
 * Getting this boundary wrong (e.g. matching "can you loosen my limits" to
 * LIMITS) would silently break the settings-change/escalation path, so it's
 * spelled out here rather than left to the model's judgment.
 */

export const MENU_INTENT_TOOL: JsonSchemaToolDef = {
  name: "classify_menu_intent",
  description:
    "Classifies the user's message as matching one of Udara's four menu actions, or none.",
  schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["BALANCE", "LIMITS", "ACCOUNT_DETAILS", "TRANSFER", "NONE"],
        description:
          "BALANCE: asking to check their current account balance. " +
          "LIMITS: asking to check their current spending-limit status (how much they've spent/have left today). " +
          "ACCOUNT_DETAILS: asking for their account number/bank details. " +
          "TRANSFER: wants to send/transfer money right now (to anyone, for any amount, however phrased). " +
          "NONE: anything else — including greetings, general questions, and any request to CHANGE, ADJUST, INCREASE, or REMOVE something (limits, spending window hours, restrictions), any exit/escalation request, or anything ambiguous. When in doubt, NONE.",
      },
    },
    required: ["intent"],
  },
};

export function buildMenuIntentSystemMessage(): LlmMessage {
  return {
    role: "system",
    content: [
      "You are a strict, narrow intent classifier for Udara, a WhatsApp financial-discipline assistant. You are not the persona the user is talking to — you never reply in your own voice, you only ever call the classify_menu_intent tool.",
      "Udara's menu offers exactly four actions: checking balance, checking spending-limit status, checking account details, and starting a money transfer. Your only job is deciding whether the user's message is clearly asking for one of those four RIGHT NOW, or not.",
      'Match on intent, not exact wording — "what\'s my balance", "how much do I have", "how much is in my account" all mean BALANCE. "Send money to my landlord", "I want to transfer 5k", "pay someone" all mean TRANSFER.',
      'Do NOT match a request to change, adjust, increase, remove, or escalate anything — "can you raise my limit", "let me out of restrictions", "change my spending hours" are NOT LIMITS or any other menu action, they are NONE. Those go through a separate settings-change flow, not the menu.',
      "Casual conversation, greetings, financial questions that aren't a direct request for one of the four actions, and anything ambiguous are all NONE. When genuinely unsure, choose NONE — a missed match just continues the normal conversation, which is always safe; a wrong match interrupts the user with the wrong screen.",
    ].join("\n\n"),
  };
}
