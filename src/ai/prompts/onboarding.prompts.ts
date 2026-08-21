import { OnboardingStage } from "@prisma/client";
import { JsonSchemaToolDef, LlmMessage } from "../llm.types";
import { KEDU_IDENTITY_ANCHOR, KEDU_VOICE_RULES } from "./kedu-persona.prompts";

/**
 * Per-stage onboarding prompts, built from the canonical Udara onboarding
 * script (docs/Udara-Onboarding-Script). Adaptations from the literal
 * script, all deliberate and documented at each site:
 *
 * 1. Stage 5 (Money Story) is voice-note-first in the script; audio stays
 *    fully stubbed in this build (explicit prior decision) — the same
 *    questions are asked as text instead, one at a time.
 * 2. Only IDENTITY (the "Four Quick Questions" stage) and MONEY_STORY route
 *    through the model at all. Every other stage — the intro/comprehension
 *    gate, the frequency follow-up, AI Reflection, the structured questions,
 *    account creation, and the plan review — is handled deterministically in
 *    OnboardingService: either there's genuinely nothing to extract (fixed
 *    copy, button choices), or getting a number/date exactly right (the
 *    plan figures, the KYC fields) matters more than any personality the
 *    model could add. AI Reflection in particular asks no new question in
 *    the script and needs no model call — it's a recap built from fields
 *    already captured, so it's fully deterministic here too.
 * 3. The BVN/NIN/DOB/email "Account Creation" step is a WhatsApp Flow (a
 *    native popup form) plus deterministic parsing, never a model tool call
 *    — these are objectively-formatted fields, not narrative answers, and
 *    guardrail philosophy says don't route a fact through a model's
 *    judgment when a form + regex settles it outright.
 */

export const QUICK_QUESTIONS_TOOL: JsonSchemaToolDef = {
  name: "record_quick_questions",
  description:
    "Records the user's name, city, monthly income, and the reason they came to Udara, once all four are known with confidence.",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What the user wants to be called" },
      city: {
        type: "string",
        description: "The city they currently live in",
      },
      monthlyIncome: {
        type: "number",
        description: "Approximate monthly income in naira",
      },
      spendingRegret: {
        type: "string",
        description:
          "Why they came to Udara — the specific spending/overeating/overshopping problem they named",
      },
    },
    required: ["name", "city", "monthlyIncome", "spendingRegret"],
  },
};

export const MONEY_STORY_TOOL: JsonSchemaToolDef = {
  name: "record_money_story",
  description:
    "Records the user's financial goal, what makes it hard to reach, and what they've already tried, once all three are known with real confidence.",
  schema: {
    type: "object",
    properties: {
      statedGoal: {
        type: "string",
        description:
          "The financial goal they're currently working toward this year",
      },
      difficulty: {
        type: "string",
        description: "What they think makes that goal difficult to achieve",
      },
      priorAttempts: {
        type: "string",
        description:
          "What they've tried before to control their spending, and what made it hard to stay consistent",
      },
    },
    required: ["statedGoal", "difficulty", "priorAttempts"],
  },
};

const PUSH_BACK_INSTRUCTION =
  "If the user's last answer is vague, evasive, or a non-answer, do NOT call the tool. Ask a natural, gentle follow-up for specifically what's missing, in your own voice. Never move on from a vague answer just to keep things moving (PRD: push back gently rather than accepting deflection). Only call the tool once you have real, usable answers for every required field, even if that takes several turns.";

function stageSystemMessage(stageInstructions: string): LlmMessage {
  return {
    role: "system",
    content: [
      KEDU_IDENTITY_ANCHOR,
      KEDU_VOICE_RULES,
      stageInstructions,
      PUSH_BACK_INSTRUCTION,
    ].join("\n\n---\n\n"),
  };
}

export interface OnboardingPromptResult {
  systemMessage: LlmMessage;
  tool: JsonSchemaToolDef;
}

/**
 * Only these two stages route through the model, see the module docblock
 * for why every other stage is handled deterministically. Returns null for
 * any stage that shouldn't call this at all (a caller bug, not a user-facing case).
 */
export function buildOnboardingPrompt(
  stage: OnboardingStage,
): OnboardingPromptResult | null {
  switch (stage) {
    case OnboardingStage.IDENTITY:
      return {
        tool: QUICK_QUESTIONS_TOOL,
        systemMessage: stageSystemMessage(
          `Onboarding stage: Four Quick Questions. This is the very first real question of onboarding; the introduction has already been sent and confirmed understood. Ask (adapt naturally, don't recite verbatim if the conversation has already moved): "for us to work together, you need a secure bank account. but before I set up your account, I need 4 quick things from you: what should I call you? where do you currently live? how much do you make monthly? why did you come to me?" All four are open-ended free text, and the user may answer them together in one message or across several, either is fine.`,
        ),
      };

    case OnboardingStage.MONEY_STORY:
      return {
        tool: MONEY_STORY_TOOL,
        systemMessage: stageSystemMessage(
          `Onboarding stage: Money Story. The canonical script asks this as one voice note covering three questions; voice notes aren't supported yet, so ask these as text instead, one at a time, in your own words, never as a dumped list: what financial goal are you currently trying to achieve this year? what do you think makes it difficult for you to achieve that goal? have you tried anything before to control your spending, and what made it hard to stay consistent?`,
        ),
      };

    default:
      return null;
  }
}
