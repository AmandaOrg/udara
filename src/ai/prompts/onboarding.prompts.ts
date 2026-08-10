import { OnboardingStage } from "@prisma/client";
import { JsonSchemaToolDef, LlmMessage } from "../llm.types";
import { KEDU_IDENTITY_ANCHOR, KEDU_VOICE_RULES } from "./kedu-persona.prompts";

/**
 * Per-stage onboarding prompts, built from the real script
 * (docs/✅-Kedu-Character-Tone-Prompt.pdf's structural principles + the
 * canonical script's actual questions/copy). Three adaptations from the
 * literal script, all deliberate and documented at each site:
 *
 * 1. The Money Story stage is voice-note-first in the script; audio stays
 *    fully stubbed in this build (explicit prior decision) — the same six
 *    questions are asked as text instead, one at a time.
 * 2. DISCOVERY/WELCOME and PLAN_PROPOSED's number presentation are handled
 *    deterministically in OnboardingService, not through the model at all —
 *    the welcome line is fixed copy with nothing to extract, and getting the
 *    daily/weekly/monthly figures exactly right (PRD: "nothing contradicts
 *    itself") matters more than any personality the model could add. Only
 *    IDENTITY, MONEY_STORY, and AI_REFLECTION genuinely need a model in the
 *    loop — the other stages are structured questions (buttons) or
 *    regex-verifiable KYC fields (BVN/email/DOB).
 * 3. The BVN/email/DOB "Trust Moment" is deterministic parsing, not a model
 *    tool call — these are objectively-formatted fields, not narrative
 *    answers, and guardrail philosophy says don't route a fact through a
 *    model's judgment when a regex settles it outright.
 */

export const IDENTITY_TOOL: JsonSchemaToolDef = {
  name: "record_identity",
  description:
    "Records the user's name and occupation once both are known with confidence.",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "What the user wants to be called" },
      occupation: {
        type: "string",
        description: "What the user does for a living",
      },
    },
    required: ["name", "occupation"],
  },
};

export const MONEY_STORY_TOOL: JsonSchemaToolDef = {
  name: "record_money_story",
  description:
    "Records the user's financial situation once monthlyIncome and statedGoal are both known with real confidence. Other fields are recorded whenever mentioned, but aren't required to call this.",
  schema: {
    type: "object",
    properties: {
      monthlyIncome: {
        type: "number",
        description: "Approximate monthly income in naira",
      },
      statedGoal: {
        type: "string",
        description: "The financial goal they're currently working toward",
      },
      spendingRegret: {
        type: "string",
        description: "What they spend on that they later regret",
      },
      spendingTrigger: {
        type: "string",
        description:
          "What tends to trigger their spending (stress, boredom, etc.)",
      },
      priorAttempts: {
        type: "string",
        description: "What they've tried before to control spending",
      },
      consistencyBlocker: {
        type: "string",
        description: "What makes it hard for them to stay consistent",
      },
    },
    required: ["monthlyIncome", "statedGoal"],
  },
};

export const REFLECTION_CONTEXT_TOOL: JsonSchemaToolDef = {
  name: "record_reflection_context",
  description:
    "Records the user's city (and age, if given) once the reflection has been shared and they've answered.",
  schema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "The city they're currently based in",
      },
      age: { type: "number", description: "Their age, if given" },
    },
    required: ["city"],
  },
};

const PUSH_BACK_INSTRUCTION =
  "If the user's last answer is vague, evasive, or a non-answer, do NOT call the tool — ask a natural, gentle follow-up for specifically what's missing, in your own voice. Never move on from a vague answer just to keep things moving (PRD: push back gently rather than accepting deflection). Only call the tool once you have real, usable answers for every required field, even if that takes several turns.";

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
 * Only these three stages route through the model — see the module docblock
 * for why every other stage is handled deterministically. Returns null for
 * any stage that shouldn't call this at all (a caller bug, not a user-facing case).
 */
export function buildOnboardingPrompt(
  stage: OnboardingStage,
): OnboardingPromptResult | null {
  switch (stage) {
    case OnboardingStage.IDENTITY:
      return {
        tool: IDENTITY_TOOL,
        systemMessage: stageSystemMessage(
          `Onboarding stage: Identity. This is the very first real question of onboarding — the welcome message has already been sent. Ask (adapt naturally, don't recite verbatim if the conversation has already moved): "First, tell me about yourself. What should I call you and what do you do for a living? This helps me understand your lifestyle, income pattern, and create a money system that fits your reality."`,
        ),
      };

    case OnboardingStage.MONEY_STORY:
      return {
        tool: MONEY_STORY_TOOL,
        systemMessage: stageSystemMessage(
          `Onboarding stage: Money Story. The canonical script asks this as one voice note covering six questions; voice notes aren't supported yet, so ask these as text instead — one at a time, in your own words, never as a dumped list:
- How much do you normally make monthly?
- What usually happens after you receive money?
- What do you spend money on that you later regret?
- What financial goal are you currently trying to achieve?
- Have you tried anything before to control your spending?
- What makes it difficult for you to stay consistent?

The two that actually gate the plan are monthly income and their stated goal — don't call the tool until both are genuinely clear, even if the others stay thin. Keep the conversation moving naturally toward whichever of those two is still missing.`,
        ),
      };

    case OnboardingStage.AI_REFLECTION:
      return {
        tool: REFLECTION_CONTEXT_TOOL,
        systemMessage: stageSystemMessage(
          `Onboarding stage: AI Reflection. You already know their income, goal, and whatever else they shared in Money Story (see the conversation history and context below). First, reflect it back to them in your own voice — a short, specific summary of what you understood, similar in spirit to: "Thanks for sharing, Daniel. I have a better understanding now. From what you told me: you earn around ₦1.5M monthly... It looks like your biggest challenge isn't earning money, it's creating a system that protects your money when emotions take over." Then ask for their age and which city they're currently based in — briefly explain why (cost of living varies a lot by city and changes what a realistic plan looks like). Call the tool once city is known (age is nice to have, not required).`,
        ),
      };

    default:
      return null;
  }
}
