import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  BudgetMethod,
  IncomePosture,
  IncomeType,
  LlmCallPurpose,
  OnboardingSession,
  OnboardingStage,
  Prisma,
  User,
} from "@prisma/client";
import { CONVERSATION_LLM, LlmMessage, LlmService } from "../ai/llm.types";
import {
  ExtractionValidatorService,
  ValidationOutcome,
} from "../ai/extraction-validator.service";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { buildOnboardingPrompt } from "../ai/prompts/onboarding.prompts";
import { ChunkedMessengerService } from "../whatsapp/chunked-messenger.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { RubiesService } from "../rubies/rubies.service";
import {
  STRUCTURED_QUESTIONS,
  STRICTNESS_LEVEL_BY_SQ4_ID,
  INCOME_POSTURE_GROW_SQ1_ID,
} from "./structured-questions.data";

/**
 * Pre-account stages route through OnboardingService; everything from
 * ACCOUNT_CREATED onward is normal app usage (transfer commands, general
 * chat) — the onboarding *conversation* is done even though funding/first
 * transaction milestones haven't happened yet. Exported for
 * WhatsappRouterService's gating decision.
 */
export function isPreAccountStage(stage: OnboardingStage): boolean {
  return (
    stage === OnboardingStage.DISCOVERY ||
    stage === OnboardingStage.WELCOME ||
    stage === OnboardingStage.IDENTITY ||
    stage === OnboardingStage.MONEY_STORY ||
    stage === OnboardingStage.AI_REFLECTION ||
    stage === OnboardingStage.STRUCTURED_QUESTIONS ||
    stage === OnboardingStage.PLAN_PROPOSED
  );
}

function inferIncomeType(occupation: string): IncomeType {
  const lower = occupation.toLowerCase();
  if (
    /founder|entrepreneur|ceo|business owner|own(s|ing)? (a |my )?business/.test(
      lower,
    )
  )
    return IncomeType.FOUNDER;
  if (/freelance|consultant|contractor/.test(lower))
    return IncomeType.MULTIPLE_STREAMS;
  return IncomeType.SALARIED;
}

type ExtractedData = Record<string, unknown>;

/**
 * The stage-based conversation engine (PRD §6, docs/✅-Kedu-Onboarding-Script.pdf).
 * The model never writes to User directly — every write below goes through
 * ExtractionValidatorService first (or is deterministic, non-AI code for
 * stages that don't need judgment — see the docblock in ai/prompts/onboarding.prompts.ts
 * for exactly which stages are which and why).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONVERSATION_LLM) private readonly llm: LlmService,
    private readonly validator: ExtractionValidatorService,
    private readonly llmLogger: LlmCallLoggerService,
    private readonly chunkedMessenger: ChunkedMessengerService,
    private readonly whatsapp: WhatsappService,
    private readonly rubies: RubiesService,
  ) {}

  async getOrStartSession(userId: string) {
    const latest = await this.prisma.onboardingSession.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (latest) return latest;

    return this.prisma.onboardingSession.create({
      data: { userId, stage: OnboardingStage.DISCOVERY, messages: [] },
    });
  }

  async appendMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ) {
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const messages = Array.isArray(session.messages) ? session.messages : [];
    messages.push({ role, content, at: new Date().toISOString() });
    return this.prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { messages },
    });
  }

  /** Also mirrors onto User.onboardingStage — the field the router/scheduler actually gate on. */
  async advanceStage(sessionId: string, nextStage: OnboardingStage) {
    const session = await this.prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { stage: nextStage },
    });
    await this.prisma.user.update({
      where: { id: session.userId },
      data: {
        onboardingStage: nextStage,
        ...(nextStage === OnboardingStage.COMPLETE
          ? { onboardingCompletedAt: new Date() }
          : {}),
      },
    });
    return session;
  }

  private async mergeExtractedData(sessionId: string, patch: ExtractedData) {
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const existing = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    return this.prisma.onboardingSession.update({
      where: { id: sessionId },
      data: {
        extractedData: { ...existing, ...patch } as Prisma.InputJsonValue,
      },
    });
  }

  // =========================================================================
  // Entry points — called by WhatsappRouterService for pre-account-stage users
  // =========================================================================

  async handleInboundText(user: User, text: string): Promise<void> {
    const session = await this.getOrStartSession(user.id);
    await this.appendMessage(session.id, "user", text);

    switch (user.onboardingStage) {
      case OnboardingStage.DISCOVERY:
      case OnboardingStage.WELCOME:
        return this.sendWelcomeAndAskIdentity(user, session.id);
      case OnboardingStage.IDENTITY:
      case OnboardingStage.MONEY_STORY:
      case OnboardingStage.AI_REFLECTION:
        return this.runAiTurn(user, session.id, user.onboardingStage);
      case OnboardingStage.STRUCTURED_QUESTIONS:
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "tap one of the options above — if the list didn't show up, try again in a moment.",
          user.id,
        );
        return;
      case OnboardingStage.PLAN_PROPOSED:
        return this.handleTrustMomentText(user, session.id, text);
      default:
        this.logger.warn(
          `handleInboundText called for user ${user.id} at post-account stage ${user.onboardingStage} — router should not route here`,
        );
    }
  }

  async handleInboundButton(user: User, buttonId: string): Promise<void> {
    if (user.onboardingStage !== OnboardingStage.STRUCTURED_QUESTIONS) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that button doesn't apply right now — let's keep going with what i just asked.",
        user.id,
      );
      return;
    }
    return this.handleStructuredAnswer(user, buttonId);
  }

  // =========================================================================
  // DISCOVERY/WELCOME — fixed script copy, nothing to extract (deterministic)
  // =========================================================================

  private async sendWelcomeAndAskIdentity(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const welcome = [
      "hey 👋 welcome to kedu.",
      "kedu helps people who earn money but struggle with impulse spending and overeating by creating a strict savings and spending system.",
      "unlike budgeting apps, savings apps, or your bank app that only show you information and wait for you to act, kedu actively helps you think through your money decisions and prevents unnecessary spending.",
      'fyi: kedu means "how are you?" in igbo.',
      "before we create your account, i want to understand your money habits. this takes about 3 minutes. please answer honestly — there's no judgment here.",
      "first, tell me about yourself. what should i call you and what do you do for a living? this helps me understand your lifestyle, income pattern, and create a money system that fits your reality.",
    ].join("\n\n");

    await this.appendMessage(sessionId, "assistant", welcome);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      welcome,
      user.id,
    );
    await this.advanceStage(sessionId, OnboardingStage.IDENTITY);
  }

  // =========================================================================
  // IDENTITY / MONEY_STORY / AI_REFLECTION — the three genuinely AI-driven stages
  // =========================================================================

  private async runAiTurn(
    user: User,
    sessionId: string,
    stage: OnboardingStage,
  ): Promise<void> {
    const promptResult = buildOnboardingPrompt(stage);
    if (!promptResult) {
      this.logger.error(
        `runAiTurn called for a stage with no AI prompt: ${stage}`,
      );
      return;
    }

    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const messages: LlmMessage[] = [
      promptResult.systemMessage,
      this.buildContextMessage(user, session),
      ...this.sessionMessagesToLlm(session),
    ];

    const result = await this.llm.complete({
      messages,
      tool: promptResult.tool,
      purpose: LlmCallPurpose.ONBOARDING_EXTRACTION,
      userId: user.id,
    });
    const log = await this.llmLogger.log({
      userId: user.id,
      purpose: LlmCallPurpose.ONBOARDING_EXTRACTION,
      result,
    });

    if (result.toolCall) {
      const outcome = this.validateToolCall(stage, result.toolCall.arguments);
      await this.llmLogger.markApplied(log.id, outcome, outcome.accepted);

      if (outcome.accepted) {
        await this.applyStageExtraction(
          user,
          sessionId,
          stage,
          outcome.cleanedValue as Record<string, unknown>,
        );
        return;
      }

      // Rejected — same handling as a vague free-text answer: stay put, ask again.
      const nudge = `hmm, ${outcome.reason ?? "that didn't quite land"} — could you say a bit more?`;
      await this.appendMessage(sessionId, "assistant", nudge);
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        nudge,
        user.id,
      );
      return;
    }

    const reply = result.text ?? "sorry, could you say that again?";
    await this.appendMessage(sessionId, "assistant", reply);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      reply,
      user.id,
    );
  }

  private validateToolCall(
    stage: OnboardingStage,
    args: unknown,
  ): ValidationOutcome {
    switch (stage) {
      case OnboardingStage.IDENTITY:
        return this.validator.validateIdentity(args);
      case OnboardingStage.MONEY_STORY:
        return this.validator.validateMoneyStory(args);
      case OnboardingStage.AI_REFLECTION:
        return this.validator.validateReflectionContext(args);
      default:
        return { accepted: false, reason: "no validator wired for this stage" };
    }
  }

  private async applyStageExtraction(
    user: User,
    sessionId: string,
    stage: OnboardingStage,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (stage === OnboardingStage.IDENTITY) {
      const name = String(value.name);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { name, occupation: String(value.occupation) },
      });
      await this.mergeExtractedData(sessionId, { identity: value });
      await this.advanceStage(sessionId, OnboardingStage.MONEY_STORY);
      await this.sendMoneyStoryQuestions(user, sessionId, name);
      return;
    }

    if (stage === OnboardingStage.MONEY_STORY) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          monthlyIncome: value.monthlyIncome as number,
          statedGoal: String(value.statedGoal),
          statedGoalSetAt: new Date(),
        },
      });
      await this.mergeExtractedData(sessionId, { moneyStory: value });
      await this.advanceStage(sessionId, OnboardingStage.AI_REFLECTION);
      // The script continues straight into the reflection turn — no new user message needed to trigger it.
      await this.runAiTurn(user, sessionId, OnboardingStage.AI_REFLECTION);
      return;
    }

    if (stage === OnboardingStage.AI_REFLECTION) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { city: String(value.city) },
      });
      await this.mergeExtractedData(sessionId, { reflectionContext: value });
      await this.advanceStage(sessionId, OnboardingStage.STRUCTURED_QUESTIONS);
      await this.sendStructuredQuestion(user, sessionId, 0);
      return;
    }
  }

  private async sendMoneyStoryQuestions(
    user: User,
    sessionId: string,
    name: string,
  ): Promise<void> {
    const firstName = name.split(" ")[0];
    const text = [
      `nice to meet you, ${firstName}.`,
      "i want to understand your current money situation — answer these (one at a time is fine, or all together, whatever's natural for you):\n\n- how much do you normally make monthly?\n- what usually happens after you receive money?\n- what do you spend money on that you later regret?\n- what financial goal are you currently trying to achieve?\n- have you tried anything before to control your spending?\n- what makes it difficult for you to stay consistent?",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", text);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      text,
      user.id,
    );
  }

  // =========================================================================
  // STRUCTURED_QUESTIONS — fixed multiple-choice via WhatsApp lists, deterministic
  // =========================================================================

  private async sendStructuredQuestion(
    user: User,
    sessionId: string,
    index: number,
  ): Promise<void> {
    const question = STRUCTURED_QUESTIONS[index];
    if (!question) return; // caller should have finalized instead of reaching an out-of-range index

    await this.mergeExtractedData(sessionId, {
      structuredQuestionIndex: index,
    });
    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      question.bodyText,
      question.buttonLabel,
      question.rows,
      user.id,
    );
  }

  private async handleStructuredAnswer(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    const index =
      typeof extractedData.structuredQuestionIndex === "number"
        ? extractedData.structuredQuestionIndex
        : 0;
    const question = STRUCTURED_QUESTIONS[index];
    if (!question) return;

    if (!question.rows.some((r) => r.id === buttonId)) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that doesn't match the current question — here it is again.",
        user.id,
      );
      await this.whatsapp.sendListMessage(
        user.whatsappNumber,
        question.bodyText,
        question.buttonLabel,
        question.rows,
        user.id,
      );
      return;
    }

    const answers = isRecord(extractedData.structuredAnswers)
      ? (extractedData.structuredAnswers as Record<string, string>)
      : {};
    answers[question.key] = buttonId;
    await this.mergeExtractedData(session.id, { structuredAnswers: answers });

    const nextIndex = index + 1;
    if (nextIndex < STRUCTURED_QUESTIONS.length) {
      await this.sendStructuredQuestion(user, session.id, nextIndex);
    } else {
      await this.finalizeStructuredQuestions(user, session.id, answers);
    }
  }

  /**
   * Computes the plan (PRD §7a income-tier branching + the script's number
   * logic: daily×7=weekly, daily×30=monthly) and presents it, then starts
   * the Trust Moment. The 20% spending-allocation baseline exactly
   * reproduces the script's own worked example (₦1.5M income -> ₦300k
   * monthly allowance -> ₦10k/day) — the rest of income is assumed
   * protected/saved outside Kedu, which the script itself never states
   * explicitly as a formula ("illustrative... generated from the actual
   * profiling formula at build time") but is the only value consistent with
   * its own example.
   */
  private async finalizeStructuredQuestions(
    user: User,
    sessionId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    // The script never asks income type (salaried/founder/multiple streams) directly —
    // inferred from occupation text as a documented simplification, correctable later.
    const incomeType = inferIncomeType(freshUser.occupation ?? "");
    const incomePosture =
      answers.sq1 === INCOME_POSTURE_GROW_SQ1_ID
        ? IncomePosture.GROW
        : IncomePosture.RESTRICT;
    const budgetMethod =
      incomeType === IncomeType.SALARIED
        ? BudgetMethod.FLAT
        : BudgetMethod.PERCENTAGE;
    const strictnessLevel = STRICTNESS_LEVEL_BY_SQ4_ID[answers.sq4] ?? 3;

    const SPENDING_ALLOCATION_PCT = 0.2;
    const monthlyIncome = Number(freshUser.monthlyIncome ?? 0);
    const monthlyAllowance =
      Math.round((monthlyIncome * SPENDING_ALLOCATION_PCT) / 1000) * 1000;
    const dailyLimit = Math.round(monthlyAllowance / 30);
    const weeklyLimit = dailyLimit * 7;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        incomeType,
        incomePosture,
        budgetMethod,
        budgetPercentage:
          budgetMethod === BudgetMethod.PERCENTAGE
            ? SPENDING_ALLOCATION_PCT
            : null,
        flatDailyAmount: budgetMethod === BudgetMethod.FLAT ? dailyLimit : null,
        strictnessLevel,
      },
    });

    await this.advanceStage(sessionId, OnboardingStage.PLAN_PROPOSED);
    await this.mergeExtractedData(sessionId, {
      plan: { dailyLimit, weeklyLimit, monthlyAllowance },
    });

    const firstName = (freshUser.name ?? "there").split(" ")[0];
    const planText = [
      `${firstName}, i have enough to build your first kedu plan.`,
      `based on your income, lifestyle, and goals:\n\ndaily spending limit: ₦${dailyLimit.toLocaleString("en-NG")}\nweekly spending limit: ₦${weeklyLimit.toLocaleString("en-NG")}\nmonthly spending allowance: ₦${monthlyAllowance.toLocaleString("en-NG")}`,
      "spending window: 11am–8pm. outside that window, transfers are locked — no exceptions. within it, if you go over your daily limit, we'll talk through it before anything moves. kedu protects the rest for your goals.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", planText);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      planText,
      user.id,
    );

    const trustText = [
      "before i can create your account, i need a few details to verify your identity — this is a bank requirement, not a kedu thing. it's the same verification any nigerian bank asks for.",
      "here's exactly what i need and why:\n\nyour bvn — this confirms you are who you say you are, and it's required by every licensed bank in nigeria before an account can be opened. kedu doesn't keep hold of your bvn once your account is created — it's passed straight through to rubies microfinance bank, who actually issues your account.\n\nyour email and date of birth — just for your account record.",
      "i know handing this over can feel like a lot, especially to something that started as a whatsapp chat. but kedu's account is a real, licensed bank account, not an iou — that's exactly why this step exists, and exactly why your money is actually protected once it's here.",
      "send me your bvn, email, and date of birth (yyyy-mm-dd) whenever you're ready — any order, one message or three.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", trustText);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      trustText,
      user.id,
    );
  }

  // =========================================================================
  // PLAN_PROPOSED (Trust Moment) — BVN/email/DOB, deterministic parsing (not model judgment)
  // =========================================================================

  private async handleTrustMomentText(
    user: User,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const extractedData: ExtractedData = isRecord(session.extractedData)
      ? { ...session.extractedData }
      : {};

    const bvnMatch = text.match(/\b(\d{11})\b/);
    // Excludes comma/semicolon too, not just whitespace — "email, dob" in one message
    // shouldn't glue the trailing punctuation onto the captured address.
    const emailMatch = text.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/);
    const dobMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);

    if (bvnMatch) extractedData.bvn = bvnMatch[1];
    if (emailMatch) extractedData.email = emailMatch[0];
    if (dobMatch) extractedData.dateOfBirth = dobMatch[1];

    await this.prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { extractedData: extractedData as Prisma.InputJsonValue },
    });

    const missing: string[] = [];
    if (!extractedData.bvn) missing.push("your BVN (11 digits)");
    if (!extractedData.email) missing.push("your email");
    if (!extractedData.dateOfBirth)
      missing.push("your date of birth (YYYY-MM-DD)");

    if (missing.length > 0) {
      const nudge = `got it — still need ${missing.join(" and ")}.`;
      await this.appendMessage(sessionId, "assistant", nudge);
      await this.whatsapp.sendText(user.whatsappNumber, nudge, user.id);
      return;
    }

    await this.provisionRubiesAccount(user, sessionId, {
      bvn: String(extractedData.bvn),
      email: String(extractedData.email),
      dateOfBirth: String(extractedData.dateOfBirth),
    });
  }

  private async provisionRubiesAccount(
    user: User,
    sessionId: string,
    kyc: { bvn: string; email: string; dateOfBirth: string },
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const [firstName, ...rest] = (freshUser.name ?? "Kedu User").split(" ");
    const lastName = rest.join(" ") || firstName;

    try {
      const account = await this.rubies.provisionAccount({
        bvn: kyc.bvn,
        firstName,
        lastName,
        phoneNumber: freshUser.whatsappNumber,
        dob: kyc.dateOfBirth,
        email: kyc.email,
      });

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          rubiesAccountId: account.accountId,
          rubiesAccountNumber: account.accountNumber,
          rubiesAccountName: account.accountName,
          rubiesBankCode: account.bankCode,
          email: kyc.email,
          dateOfBirth: new Date(kyc.dateOfBirth),
          // Deliberately never writing bvn to the User record — see the trust-moment
          // copy above. Scrubbed from the session below too, its job now done.
        },
      });

      const session = await this.prisma.onboardingSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const extractedData = isRecord(session.extractedData)
        ? { ...session.extractedData }
        : {};
      delete extractedData.bvn;
      await this.prisma.onboardingSession.update({
        where: { id: sessionId },
        data: { extractedData: extractedData as Prisma.InputJsonValue },
      });

      await this.advanceStage(sessionId, OnboardingStage.ACCOUNT_CREATED);

      const plan = isRecord(extractedData.plan)
        ? (extractedData.plan as { monthlyAllowance?: number })
        : {};
      const monthlyAllowance = plan.monthlyAllowance ?? 0;

      const confirmText = [
        `your kedu account has been created successfully 🎉 your account number is: ${account.accountNumber}.`,
        "pin this chat so you can send money here anytime.",
        `your next step is to fund your kedu account. send ₦${monthlyAllowance.toLocaleString("en-NG")} into this account — that's your full monthly allowance based on the plan we just built. once received, kedu will automatically activate your spending plan.`,
      ].join("\n\n");
      await this.appendMessage(sessionId, "assistant", confirmText);
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        confirmText,
        user.id,
      );
    } catch (err) {
      this.logger.warn(
        `Rubies provisionAccount failed for user ${user.id}: ${String(err)}`,
      );

      // Clear the likely-bad fields (not email, lowest risk of being the actual fault)
      // so the retry doesn't loop forever on stale data.
      const session = await this.prisma.onboardingSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const extractedData = isRecord(session.extractedData)
        ? { ...session.extractedData }
        : {};
      delete extractedData.bvn;
      delete extractedData.dateOfBirth;
      await this.prisma.onboardingSession.update({
        where: { id: sessionId },
        data: { extractedData: extractedData as Prisma.InputJsonValue },
      });

      const message = `that didn't go through — ${(err as Error).message || "rubies rejected the details"}. mind double-checking your bvn and date of birth and resending?`;
      await this.appendMessage(sessionId, "assistant", message);
      await this.whatsapp.sendText(user.whatsappNumber, message, user.id);
    }
  }

  // =========================================================================
  // Shared helpers
  // =========================================================================

  private sessionMessagesToLlm(session: OnboardingSession): LlmMessage[] {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    return messages.slice(-20).map((raw) => {
      const m = raw as { role?: string; content?: string };
      return {
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      };
    });
  }

  private buildContextMessage(
    user: User,
    session: OnboardingSession,
  ): LlmMessage {
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    const moneyStory = isRecord(extractedData.moneyStory)
      ? extractedData.moneyStory
      : {};

    const known: string[] = [];
    if (user.name) known.push(`name: ${user.name}`);
    if (user.occupation) known.push(`occupation: ${user.occupation}`);
    if (user.monthlyIncome)
      known.push(
        `monthly income: ~₦${Number(user.monthlyIncome).toLocaleString("en-NG")}`,
      );
    if (user.statedGoal) known.push(`stated goal: ${user.statedGoal}`);
    if (user.city) known.push(`city: ${user.city}`);
    if (typeof moneyStory.spendingRegret === "string")
      known.push(`spending regret: ${moneyStory.spendingRegret}`);
    if (typeof moneyStory.spendingTrigger === "string")
      known.push(`spending trigger: ${moneyStory.spendingTrigger}`);

    return {
      role: "system",
      content:
        known.length > 0
          ? `Already known about this user so far:\n${known.join("\n")}`
          : "Nothing confirmed about this user yet.",
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
