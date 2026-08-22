import { Injectable } from "@nestjs/common";

export interface ValidationOutcome<T = unknown> {
  accepted: boolean;
  cleanedValue?: T;
  reason?: string;
}

export interface QuickQuestionsFields {
  name: string;
  city: string;
  monthlyIncome: number;
  spendingRegret: string;
}

export interface MoneyStoryFields {
  statedGoal: string;
  difficulty: string;
  priorAttempts: string;
}

export type MenuIntent =
  "BALANCE" | "LIMITS" | "ACCOUNT_DETAILS" | "TRANSFER" | "NONE";

const MENU_INTENT_VALUES: ReadonlySet<string> = new Set([
  "BALANCE",
  "LIMITS",
  "ACCOUNT_DETAILS",
  "TRANSFER",
  "NONE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * The guardrail boundary — "every model output is a proposal, never a
 * command" (existing comments in onboarding.service.ts/manager.service.ts).
 * This is the only thing permitted to hand a model's tool-call arguments to
 * OnboardingService's write path. Per-field bounds are deliberately generous
 * (this is about catching malformed/implausible data, not second-guessing
 * legitimate answers) but real: a rejection here means OnboardingService
 * treats the turn exactly like a vague free-text answer — stays on stage,
 * asks again — rather than silently writing garbage to User.
 */
@Injectable()
export class ExtractionValidatorService {
  validateQuickQuestions(
    args: unknown,
  ): ValidationOutcome<QuickQuestionsFields> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

    const name = cleanString(args.name, 100);
    if (!name)
      return { accepted: false, reason: "name is missing or implausible" };

    const city = cleanString(args.city, 100);
    if (!city)
      return { accepted: false, reason: "city is missing or implausible" };

    const monthlyIncome = Number(args.monthlyIncome);
    if (
      !Number.isFinite(monthlyIncome) ||
      monthlyIncome < 1_000 ||
      monthlyIncome > 500_000_000
    ) {
      return {
        accepted: false,
        reason: "monthlyIncome is missing or outside a plausible range",
      };
    }

    const spendingRegret = cleanString(args.spendingRegret, 500);
    if (!spendingRegret)
      return {
        accepted: false,
        reason: "spendingRegret is missing or implausible",
      };

    return {
      accepted: true,
      cleanedValue: { name, city, monthlyIncome, spendingRegret },
    };
  }

  validateMoneyStory(args: unknown): ValidationOutcome<MoneyStoryFields> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

    const statedGoal = cleanString(args.statedGoal, 500);
    if (!statedGoal)
      return {
        accepted: false,
        reason: "statedGoal is missing or implausible",
      };

    const difficulty = cleanString(args.difficulty, 500);
    if (!difficulty)
      return {
        accepted: false,
        reason: "difficulty is missing or implausible",
      };

    const priorAttempts = cleanString(args.priorAttempts, 500);
    if (!priorAttempts)
      return {
        accepted: false,
        reason: "priorAttempts is missing or implausible",
      };

    return {
      accepted: true,
      cleanedValue: { statedGoal, difficulty, priorAttempts },
    };
  }

  /**
   * Not extraction — a closed-set classification result (see
   * IntentRouterService/menu-intent.prompts.ts). Same boundary role though:
   * IntentRouterService never trusts a tool call's shape without this
   * passing first, same as onboarding's writes never trust a tool call
   * without validateQuickQuestions/validateMoneyStory passing first.
   */
  validateMenuIntent(args: unknown): ValidationOutcome<MenuIntent> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

    const intent = args.intent;
    if (typeof intent !== "string" || !MENU_INTENT_VALUES.has(intent)) {
      return { accepted: false, reason: "intent is missing or unrecognized" };
    }

    return { accepted: true, cleanedValue: intent as MenuIntent };
  }
}
