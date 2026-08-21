import { ListRow } from "../whatsapp/whatsapp.service";

/**
 * The Udara onboarding script's Stage 7 structured questions, deterministic,
 * not AI-driven at all: fixed multiple-choice, no narrative judgment needed
 * (PRD/tone-doc philosophy: keep what's dumb, dumb). WhatsApp list rows cap
 * titles at 24 chars, so each row's `title` is a short label and the full
 * script wording lives in `description`. `id` is the canonical value parsed
 * back out of the button reply, never the (truncated) title.
 *
 * Two questions, not four: the script's own Stage 7 lists a third question
 * ("how often do you spend money you didn't plan to spend") that the script
 * itself flags as covering near-identical ground to Stage 3b's frequency
 * follow-up, and asks whoever implements it to decide whether to merge them.
 * Decision made: merged, Stage 3b's answer (OnboardingService.FREQUENCY_ROWS)
 * is reused instead of asking a second time. The old income-posture question
 * (GROW vs RESTRICT budgeting) is dropped entirely too, not merged, since the
 * budgeting formula itself is now a single universal 30%-of-income rule with
 * no income-tier branching to feed.
 */
export interface StructuredQuestion {
  key: string;
  bodyText: string;
  buttonLabel: string;
  rows: ListRow[];
}

export const STRUCTURED_QUESTIONS: StructuredQuestion[] = [
  {
    key: "sq1",
    bodyText: "what are your biggest impulse spending areas?",
    buttonLabel: "Choose one",
    rows: [
      {
        id: "sq1:food",
        title: "Food/restaurants",
        description: "Food delivery/restaurants",
      },
      { id: "sq1:shopping", title: "Shopping", description: "Shopping" },
      {
        id: "sq1:nightlife",
        title: "Drinks/nightlife",
        description: "Drinks/nightlife",
      },
      {
        id: "sq1:social",
        title: "Friends/social",
        description: "Friends/social activities",
      },
      {
        id: "sq1:online",
        title: "Online purchases",
        description: "Online purchases",
      },
      { id: "sq1:other", title: "Other", description: "Other" },
    ],
  },
  {
    key: "sq2",
    bodyText: "how strict do you want Udara to be?",
    buttonLabel: "Choose one",
    rows: [
      {
        id: "sq2:remind",
        title: "Remind me",
        description: "Remind me when I overspend",
      },
      {
        id: "sq2:track",
        title: "Help me track",
        description: "Help me track my money",
      },
      {
        id: "sq2:limits",
        title: "Give me limits",
        description: "Give me spending limits",
      },
      {
        id: "sq2:strict",
        title: "Strictly protect me",
        description: "Strictly protect me from overspending",
      },
    ],
  },
];

/** Q2's answer maps directly onto User.strictnessLevel (1 = loosest, 4 = strictest). */
export const STRICTNESS_LEVEL_BY_SQ2_ID: Record<string, number> = {
  "sq2:remind": 1,
  "sq2:track": 2,
  "sq2:limits": 3,
  "sq2:strict": 4,
};
