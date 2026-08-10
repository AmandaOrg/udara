import { Injectable } from "@nestjs/common";

export interface ValidationOutcome<T = unknown> {
  accepted: boolean;
  cleanedValue?: T;
  reason?: string;
}

export interface IdentityFields {
  name: string;
  occupation: string;
}

export interface MoneyStoryFields {
  monthlyIncome: number;
  statedGoal: string;
  spendingRegret?: string;
  spendingTrigger?: string;
  priorAttempts?: string;
  consistencyBlocker?: string;
}

export interface ReflectionContextFields {
  city: string;
  age?: number;
}

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
  validateIdentity(args: unknown): ValidationOutcome<IdentityFields> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

    const name = cleanString(args.name, 100);
    if (!name)
      return { accepted: false, reason: "name is missing or implausible" };

    const occupation = cleanString(args.occupation, 150);
    if (!occupation)
      return {
        accepted: false,
        reason: "occupation is missing or implausible",
      };

    return { accepted: true, cleanedValue: { name, occupation } };
  }

  validateMoneyStory(args: unknown): ValidationOutcome<MoneyStoryFields> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

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

    const statedGoal = cleanString(args.statedGoal, 500);
    if (!statedGoal)
      return {
        accepted: false,
        reason: "statedGoal is missing or implausible",
      };

    return {
      accepted: true,
      cleanedValue: {
        monthlyIncome,
        statedGoal,
        spendingRegret: cleanString(args.spendingRegret, 500) ?? undefined,
        spendingTrigger: cleanString(args.spendingTrigger, 300) ?? undefined,
        priorAttempts: cleanString(args.priorAttempts, 500) ?? undefined,
        consistencyBlocker:
          cleanString(args.consistencyBlocker, 500) ?? undefined,
      },
    };
  }

  validateReflectionContext(
    args: unknown,
  ): ValidationOutcome<ReflectionContextFields> {
    if (!isRecord(args))
      return { accepted: false, reason: "malformed tool call" };

    const city = cleanString(args.city, 100);
    if (!city)
      return { accepted: false, reason: "city is missing or implausible" };

    let age: number | undefined;
    if (args.age !== undefined && args.age !== null) {
      const parsedAge = Number(args.age);
      if (!Number.isFinite(parsedAge) || parsedAge < 16 || parsedAge > 100) {
        return {
          accepted: false,
          reason: "age is present but outside a plausible range",
        };
      }
      age = parsedAge;
    }

    return { accepted: true, cleanedValue: { city, age } };
  }
}
