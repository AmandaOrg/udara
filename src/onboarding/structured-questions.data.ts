import { ListRow } from "../whatsapp/whatsapp.service";

/**
 * The onboarding script's Stage 6 structured questions — deterministic, not
 * AI-driven at all: fixed multiple-choice, no narrative judgment needed
 * (PRD/tone-doc philosophy: keep what's dumb, dumb). WhatsApp list rows cap
 * titles at 24 chars, so each row's `title` is a short label and the full
 * script wording lives in `description`. `id` is the canonical value parsed
 * back out of the button reply — never the (truncated) title.
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
    bodyText: "Which statement describes you best?",
    buttonLabel: "Choose one",
    rows: [
      {
        id: "sq1:no_earn",
        title: "I don't earn enough",
        description: "I don't earn enough",
      },
      {
        id: "sq1:earn_struggle",
        title: "Earn ok, spend too much",
        description: "I earn enough but struggle to control spending",
      },
      {
        id: "sq1:save_inconsistent",
        title: "Save, but inconsistent",
        description: "I save but struggle to stay consistent",
      },
      {
        id: "sq1:disappears",
        title: "Money disappears fast",
        description: "Money comes in but disappears quickly",
      },
      {
        id: "sq1:disciplined",
        title: "Already disciplined",
        description: "I am already disciplined",
      },
    ],
  },
  {
    key: "sq2",
    bodyText: "What are your biggest impulse spending areas?",
    buttonLabel: "Choose one",
    rows: [
      {
        id: "sq2:food",
        title: "Food/restaurants",
        description: "Food delivery/restaurants",
      },
      { id: "sq2:shopping", title: "Shopping", description: "Shopping" },
      {
        id: "sq2:nightlife",
        title: "Drinks/nightlife",
        description: "Drinks/nightlife",
      },
      {
        id: "sq2:social",
        title: "Friends/social",
        description: "Friends/social activities",
      },
      {
        id: "sq2:online",
        title: "Online purchases",
        description: "Online purchases",
      },
      { id: "sq2:other", title: "Other", description: "Other" },
    ],
  },
  {
    key: "sq3",
    bodyText: "How often do you spend money you didn't plan to spend?",
    buttonLabel: "Choose one",
    rows: [
      { id: "sq3:never", title: "Almost never", description: "Almost never" },
      {
        id: "sq3:few_month",
        title: "1-3x a month",
        description: "1-3 times a month",
      },
      { id: "sq3:weekly", title: "Weekly", description: "Weekly" },
      {
        id: "sq3:multi_week",
        title: "Multiple times/week",
        description: "Multiple times every week",
      },
      { id: "sq3:daily", title: "Almost daily", description: "Almost daily" },
    ],
  },
  {
    key: "sq4",
    bodyText: "How strict do you want Kedu to be?",
    buttonLabel: "Choose one",
    rows: [
      {
        id: "sq4:remind",
        title: "Remind me",
        description: "Remind me when I overspend",
      },
      {
        id: "sq4:track",
        title: "Help me track",
        description: "Help me track my money",
      },
      {
        id: "sq4:limits",
        title: "Give me limits",
        description: "Give me spending limits",
      },
      {
        id: "sq4:strict",
        title: "Strictly protect me",
        description: "Strictly protect me from overspending",
      },
    ],
  },
];

/** Q4's answer maps directly onto User.strictnessLevel (1 = loosest, 4 = strictest). */
export const STRICTNESS_LEVEL_BY_SQ4_ID: Record<string, number> = {
  "sq4:remind": 1,
  "sq4:track": 2,
  "sq4:limits": 3,
  "sq4:strict": 4,
};

/**
 * Q1's answer is the most direct self-report of "does restricting further
 * even make sense for this person" (PRD §2 income-tier branching) — more
 * faithful than guessing from a reported income figure alone.
 */
export const INCOME_POSTURE_GROW_SQ1_ID = "sq1:no_earn";
