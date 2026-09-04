import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import {
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
import { displayFirstNameOrThere } from "../common/display-name.util";
import {
  TERMS_CONSENT_QUESTION,
  TERMS_CONSEQUENCES_DETAIL,
  TERMS_SUMMARY,
  TERMS_VERSION,
} from "./terms.data";
import {
  STRUCTURED_QUESTIONS,
  STRICTNESS_LEVEL_BY_SQ2_ID,
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
    stage === OnboardingStage.TERMS_CONSENT ||
    stage === OnboardingStage.IDENTITY ||
    stage === OnboardingStage.FREQUENCY_CHECK ||
    stage === OnboardingStage.PLAN_PROPOSED ||
    stage === OnboardingStage.MONEY_STORY ||
    stage === OnboardingStage.AI_REFLECTION ||
    stage === OnboardingStage.STRUCTURED_QUESTIONS ||
    stage === OnboardingStage.PLAN_REVIEW
  );
}

type ExtractedData = Record<string, unknown>;

const INTRO_YES = "intro:yes";
const INTRO_NO = "intro:no";
const INTRO_BUTTONS = [
  { id: INTRO_YES, title: "Yes, I understand" },
  { id: INTRO_NO, title: "No, explain more" },
];

const TERMS_AGREE = "terms:agree";
const TERMS_DETAIL = "terms:detail";
const TERMS_BUTTONS = [
  { id: TERMS_AGREE, title: "I agree" },
  { id: TERMS_DETAIL, title: "What if I break it?" },
];

const FREQ_WEEKLY = "freq:weekly";
const FREQ_MONTHLY = "freq:monthly";
const FREQ_OFTEN = "freq:often";

const MONEY_STORY_YES = "money_story:yes";
const MONEY_STORY_NO = "money_story:no";

const PLAN_REVIEW_FEELS_RIGHT = "plan_review:feels_right";
const PLAN_REVIEW_ADJUST = "plan_review:adjust";

/**
 * The stage-based conversation engine (PRD §6, docs/Udara-Onboarding-Script).
 * The model never writes to User directly — every write below goes through
 * ExtractionValidatorService first (or is deterministic, non-AI code for
 * stages that don't need judgment — see the docblock in ai/prompts/onboarding.prompts.ts
 * for exactly which stages are which and why).
 */
/**
 * Onboarding turns are not on the orchestrator's 8.5s budget — nobody is
 * mid-wizard — but they still need a ceiling, or a hung provider leaves a new
 * user staring at a typing indicator.
 */
const ONBOARDING_LLM_TIMEOUT_MS = 20_000;

/**
 * Pre-account get-me-out words, matched before the stage machine.
 *
 * Deliberately explicit. Vaguer words like "what" or "huh" are perfectly
 * ordinary answers during onboarding — someone asked their income can reasonably
 * reply "what" — and swallowing those would replace a real answer with a canned
 * one, which is the opposite of the problem this solves.
 */
const HELP_WORDS =
  /^(help|start over|restart|i'?m stuck|i am stuck|what can i do)[\s!?.]*$/i;

const HELP_TEXT = [
  "no wahala. here's where we are: i'm setting you up, and i can't move money or open your account until we finish.",
  "you can answer in your own words, i'll ask again if i don't get it. if a form didn't open, say so and i'll send it again.",
  "if you'd rather not continue, just stop replying and nothing happens — no account is created and no money moves.",
].join("\n\n");

/** Turns kept on the row; the model sees the last 20. */
const STORED_HISTORY_LIMIT = 60;

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
      // Trimmed on write. Only the last 20 turns are sent to the model, but the
      // stored array was unbounded and is read and rewritten whole every turn.
      data: { messages: messages.slice(-STORED_HISTORY_LIMIT) },
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

    // Escape hatches, checked before the stage machine. Several stages accept
    // only one shape of answer and re-send the same prompt to anything else —
    // so a user who could not produce that answer (no fixed income to state, a
    // question they did not understand) had no way out at all, and no way to
    // ask for one, before they even had an account.
    if (HELP_WORDS.test(text.trim())) {
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        HELP_TEXT,
        user.id,
      );
      return;
    }

    switch (user.onboardingStage) {
      case OnboardingStage.DISCOVERY:
        return this.sendIntroduction(user, session.id);
      case OnboardingStage.WELCOME:
        return this.nudgeIntroButtons(user);
      case OnboardingStage.IDENTITY:
      case OnboardingStage.MONEY_STORY:
        return this.runAiTurn(user, session.id, user.onboardingStage);
      case OnboardingStage.TERMS_CONSENT:
        await this.whatsapp.sendInteractiveButtons(
          user.whatsappNumber,
          TERMS_CONSENT_QUESTION,
          TERMS_BUTTONS,
          user.id,
        );
        return;
      case OnboardingStage.FREQUENCY_CHECK:
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "tap one of the options above.",
          user.id,
        );
        return;
      case OnboardingStage.STRUCTURED_QUESTIONS:
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "tap one of the options above, if the list didn't show up, try again in a moment.",
          user.id,
        );
        return;
      case OnboardingStage.PLAN_PROPOSED:
        return this.handleTrustMomentText(user, session.id);
      case OnboardingStage.PLAN_REVIEW:
        return this.handlePlanReviewText(user, session.id, text);
      default:
        this.logger.warn(
          `handleInboundText called for user ${user.id} at post-account stage ${user.onboardingStage} — router should not route here`,
        );
    }
  }

  async handleInboundButton(user: User, buttonId: string): Promise<void> {
    switch (user.onboardingStage) {
      case OnboardingStage.WELCOME:
        return this.handleIntroConfirmation(user, buttonId);
      case OnboardingStage.TERMS_CONSENT:
        return this.handleTermsConsent(user, buttonId);
      case OnboardingStage.FREQUENCY_CHECK:
        return this.handleFrequencyAnswer(user, buttonId);
      case OnboardingStage.MONEY_STORY:
        return this.handleMoneyStoryConfirmation(user, buttonId);
      case OnboardingStage.STRUCTURED_QUESTIONS:
        return this.handleStructuredAnswer(user, buttonId);
      case OnboardingStage.PLAN_REVIEW:
        return this.handlePlanReviewChoice(user, buttonId);
      default:
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "that button doesn't apply right now, let's keep going with what i just asked.",
          user.id,
        );
    }
  }

  /**
   * Entry point for a WhatsApp Flow submission — currently only the
   * Account Creation step's KYC form. Deterministic parsing only: the
   * model never sees BVN/NIN/DOB/email, and nothing here is a "proposal"
   * that needs ExtractionValidatorService — it's a structured form the
   * user filled in themselves.
   */
  async handleInboundFlowReply(
    user: User,
    responseJson: Record<string, unknown>,
    sensitive: Record<string, string> = {},
  ): Promise<void> {
    if (user.onboardingStage !== OnboardingStage.PLAN_PROPOSED) {
      this.logger.warn(
        `handleInboundFlowReply called for user ${user.id} at stage ${user.onboardingStage} — router should not route here`,
      );
      return;
    }

    const session = await this.getOrStartSession(user.id);

    const firstName = String(responseJson.first_name ?? "").trim();
    const middleName = String(responseJson.middle_name ?? "").trim();
    const lastName = String(responseJson.last_name ?? "").trim();
    const idType = String(responseJson.id_type ?? "").toUpperCase();
    // id_number and date_of_birth are stripped from the persisted
    // WhatsappMessage row before it reaches here (see
    // whatsapp/sensitive-fields.util.ts), so they arrive via `sensitive`,
    // in memory only. responseJson would hold "[redacted]" for both.
    const idNumber = String(sensitive.id_number ?? "").replace(/\D/g, "");
    const email = String(responseJson.email ?? "").trim();
    const dateOfBirth = parseFlowDate(sensitive.date_of_birth);

    const problems: string[] = [];
    if (!firstName) {
      problems.push("your first name is missing");
    }
    if (!lastName) {
      problems.push("your last name is missing");
    }
    if (idType !== "BVN" && idType !== "NIN") {
      problems.push("pick either BVN or NIN");
    }
    if (idNumber.length !== 11) {
      problems.push("the ID number should be 11 digits");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push("that email doesn't look right");
    }
    if (!dateOfBirth) {
      problems.push("your date of birth didn't come through right");
    }

    if (problems.length > 0) {
      const nudge = `hmm, ${problems.join(" and ")}, let's try that again:`;
      await this.appendMessage(session.id, "assistant", nudge);
      await this.whatsapp.sendText(user.whatsappNumber, nudge, user.id);
      await this.sendKycFlow(user);
      return;
    }

    await this.provisionRubiesAccount(user, session.id, {
      firstName,
      // Optional field — "" (not present) is a valid value, distinct from "missing/invalid".
      middleName: middleName || undefined,
      lastName,
      idType: idType as "BVN" | "NIN",
      idNumber,
      email,
      // Non-null: the `!dateOfBirth` check above already returned if this were null.
      dateOfBirth: dateOfBirth!,
    });
  }

  // =========================================================================
  // DISCOVERY / WELCOME — Personal Introduction + comprehension-check gate.
  // Fixed script copy, nothing to extract (deterministic). The user must tap
  // "Yes, I understand" before onboarding continues; "No, explain more"
  // re-explains and re-asks rather than advancing.
  // =========================================================================

  private async sendIntroduction(user: User, sessionId: string): Promise<void> {
    const intro = [
      "hey 👋 my name is udara.",
      "i'm an ai financial assistant that helps you stop impulse spending, overeating, and overshopping, through strict saving plans and financial education.",
      "most saving apps and banking platforms just let you put money in and spend it without thinking about what tomorrow holds. i do the opposite. i help you think through your expenses and align your finances with what you actually want your future to look like.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", intro);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      intro,
      user.id,
    );

    await this.sendComprehensionCheck(user, sessionId);
    await this.advanceStage(sessionId, OnboardingStage.WELCOME);
  }

  private async sendComprehensionCheck(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const question = "do you understand?";
    await this.appendMessage(sessionId, "assistant", question);
    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      question,
      INTRO_BUTTONS,
      user.id,
    );
  }

  private async nudgeIntroButtons(user: User): Promise<void> {
    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      "do you understand?",
      INTRO_BUTTONS,
      user.id,
    );
  }

  private async handleIntroConfirmation(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);

    if (buttonId === INTRO_NO) {
      const longer = [
        "sure, let me put it another way.",
        "most banking and savings apps are passive: they hold your money and let you spend it however and whenever, then just show you a summary afterward, when it's too late to change anything.",
        "udara is different. i sit between you and your spending. every transfer out of your udara account goes through me first, i check it against a plan built specifically around your income and goals, and i say something if it doesn't fit. the point isn't to make your life harder, it's to catch the moments you'd otherwise regret later.",
      ].join("\n\n");
      await this.appendMessage(session.id, "assistant", longer);
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        longer,
        user.id,
      );
      await this.sendComprehensionCheck(user, session.id);
      return; // stays on WELCOME
    }

    if (buttonId === INTRO_YES) {
      await this.advanceStage(session.id, OnboardingStage.TERMS_CONSENT);
      await this.sendTerms(user, session.id);
      return;
    }

    await this.nudgeIntroButtons(user);
  }

  // =========================================================================
  // TERMS_CONSENT — the terms and their consequences, then explicit consent.
  // Deliberately before IDENTITY: nothing personal is collected until the
  // user has agreed to what they're agreeing to.
  // =========================================================================

  private async sendTerms(user: User, sessionId: string): Promise<void> {
    for (const part of TERMS_SUMMARY) {
      await this.appendMessage(sessionId, "assistant", part);
    }
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      TERMS_SUMMARY.join("\n\n"),
      user.id,
    );
    await this.askForConsent(user, sessionId);
  }

  private async askForConsent(user: User, sessionId: string): Promise<void> {
    await this.appendMessage(sessionId, "assistant", TERMS_CONSENT_QUESTION);
    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      TERMS_CONSENT_QUESTION,
      TERMS_BUTTONS,
      user.id,
    );
  }

  private async handleTermsConsent(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);

    if (buttonId === TERMS_DETAIL) {
      const detail = TERMS_CONSEQUENCES_DETAIL.join("\n\n");
      await this.appendMessage(session.id, "assistant", detail);
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        detail,
        user.id,
      );
      await this.askForConsent(user, session.id);
      return; // stays on TERMS_CONSENT — consent is not implied by reading more
    }

    if (buttonId === TERMS_AGREE) {
      // Recorded with a version so a later terms change is distinguishable
      // from never having consented at all.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION },
      });
      await this.mergeExtractedData(session.id, {
        termsVersion: TERMS_VERSION,
      });

      await this.whatsapp.sendText(
        user.whatsappNumber,
        "noted, and thank you for actually reading it. let's get you set up.",
        user.id,
      );
      await this.advanceStage(session.id, OnboardingStage.IDENTITY);
      await this.sendQuickQuestions(user, session.id);
      return;
    }

    await this.askForConsent(user, session.id);
  }

  // =========================================================================
  // IDENTITY — "Four Quick Questions" (name, city, monthly income, why they
  // came) and MONEY_STORY — the two genuinely AI-driven stages.
  // =========================================================================

  private async sendQuickQuestions(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const text = [
      "for us to work together, you need a secure bank account.",
      "but before i set up your account, i need 4 quick things from you:\n\nwhat should i call you?\nwhere do you currently live?\nhow much do you make monthly?\nwhy did you come to me?",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", text);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      text,
      user.id,
    );
  }

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

    // Wrapped, timed out, and answered. This call had none of those: a provider
    // blip threw all the way to the controller, which logged it and marked the
    // message FAILED, so a user midway through onboarding — before they have an
    // account, before they have any reason to trust this thing — got complete
    // silence, and got it again on every retry.
    let result;
    try {
      result = await this.llm.complete({
        messages,
        tool: promptResult.tool,
        purpose: LlmCallPurpose.ONBOARDING_EXTRACTION,
        userId: user.id,
        timeoutMs: ONBOARDING_LLM_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(
        `Onboarding LLM turn failed for user ${user.id} at ${stage}: ${String(err)}`,
      );
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        "sorry, i didn't catch that. could you say it again?",
        user.id,
      );
      return;
    }
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
      const nudge = `hmm, ${outcome.reason ?? "that didn't quite land"}, could you say a bit more?`;
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
        return this.validator.validateQuickQuestions(args);
      case OnboardingStage.MONEY_STORY:
        return this.validator.validateMoneyStory(args);
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
      const city = String(value.city);
      const monthlyIncome = value.monthlyIncome as number;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { name, city, monthlyIncome },
      });
      await this.mergeExtractedData(sessionId, { quickQuestions: value });
      await this.advanceStage(sessionId, OnboardingStage.FREQUENCY_CHECK);
      await this.sendFrequencyCheck(user, sessionId, name);
      return;
    }

    if (stage === OnboardingStage.MONEY_STORY) {
      // Confirm-back, not a straight write: the script's original design for
      // this step is a voice-note transcription confirmed back to the user
      // before it's trusted ("did I get that right?"). Kept even though
      // input is text for now, not voice — see
      // handleMoneyStoryConfirmation for where this actually gets written.
      await this.mergeExtractedData(sessionId, { pendingMoneyStory: value });

      const summary = this.buildMoneyStorySummary(
        value as {
          statedGoal: string;
          difficulty: string;
          priorAttempts: string;
        },
      );
      const confirm = `here's what i heard: ${summary} did i get that right?`;
      await this.appendMessage(sessionId, "assistant", confirm);
      await this.whatsapp.sendInteractiveButtons(
        user.whatsappNumber,
        confirm,
        [
          { id: MONEY_STORY_YES, title: "Yes, that's right" },
          { id: MONEY_STORY_NO, title: "No, let me clarify" },
        ],
        user.id,
      );
      return;
    }
  }

  private buildMoneyStorySummary(value: {
    statedGoal: string;
    difficulty: string;
    priorAttempts: string;
  }): string {
    return `your goal is ${value.statedGoal}. ${value.difficulty} ${value.priorAttempts}`;
  }

  private async handleMoneyStoryConfirmation(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    const pending = isRecord(extractedData.pendingMoneyStory)
      ? extractedData.pendingMoneyStory
      : null;

    if (buttonId === MONEY_STORY_NO) {
      await this.mergeExtractedData(session.id, { pendingMoneyStory: null });
      const nudge = "no worries, tell me again, what should i have gotten?";
      await this.appendMessage(session.id, "assistant", nudge);
      await this.whatsapp.sendText(user.whatsappNumber, nudge, user.id);
      return; // stays on MONEY_STORY — the next text message re-triggers the AI turn
    }

    if (buttonId !== MONEY_STORY_YES || !pending) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "tap one of the options above.",
        user.id,
      );
      return;
    }

    const value = pending as {
      statedGoal: string;
      difficulty: string;
      priorAttempts: string;
    };
    await this.prisma.user.update({
      where: { id: user.id },
      data: { statedGoal: value.statedGoal, statedGoalSetAt: new Date() },
    });
    await this.mergeExtractedData(session.id, {
      moneyStory: value,
      pendingMoneyStory: null,
    });
    await this.advanceStage(session.id, OnboardingStage.AI_REFLECTION);
    await this.sendReflectionAndFirstStructuredQuestion(user, session.id);
  }

  private async sendMoneyStoryQuestions(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const firstName = displayFirstNameOrThere(freshUser.name);
    const text = [
      `now that your account is set up, ${firstName}, i want to actually understand your money situation deeply, so that the plan i build for you fits your real life, not a guess.`,
      "tell me:\n\nwhat financial goal are you currently trying to achieve this year?\nwhat do you think makes it difficult for you to achieve that goal?\nhave you tried anything before to control your spending, and what made it hard to stay consistent?",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", text);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      text,
      user.id,
    );
  }

  // =========================================================================
  // FREQUENCY_CHECK — Stage 3b, a button follow-up on the "why did you come
  // to me" answer. Also stands in for what used to be a separate, near-
  // duplicate structured question about unplanned-spending frequency — see
  // structured-questions.data.ts.
  // =========================================================================

  private async sendFrequencyCheck(
    user: User,
    sessionId: string,
    _name: string,
  ): Promise<void> {
    const question = "got it. how often does this happen?";
    await this.appendMessage(sessionId, "assistant", question);
    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      question,
      [
        { id: FREQ_WEEKLY, title: "Weekly" },
        { id: FREQ_MONTHLY, title: "Monthly" },
        { id: FREQ_OFTEN, title: "Almost every payday" },
      ],
      user.id,
    );
  }

  private async handleFrequencyAnswer(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);
    if (![FREQ_WEEKLY, FREQ_MONTHLY, FREQ_OFTEN].includes(buttonId)) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "tap one of the options above.",
        user.id,
      );
      return;
    }

    await this.mergeExtractedData(session.id, { spendingFrequency: buttonId });

    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const firstName = displayFirstNameOrThere(freshUser.name);
    const ack = `got it, ${firstName}.`;
    await this.appendMessage(session.id, "assistant", ack);
    await this.whatsapp.sendText(user.whatsappNumber, ack, user.id);

    await this.advanceStage(session.id, OnboardingStage.PLAN_PROPOSED);
    await this.sendAccountCreationAsk(freshUser, session.id);
  }

  // =========================================================================
  // PLAN_PROPOSED — Account Creation (BVN/NIN + DOB + email via a WhatsApp
  // Flow, native popup form, never free text and never the model). Fires
  // right after Frequency Check now, not at the end of onboarding — see
  // handleInboundFlowReply for the actual submission handler.
  // =========================================================================

  private async sendAccountCreationAsk(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const firstName = displayFirstNameOrThere(user.name);
    const text = [
      `${firstName}, this is exactly where i help the most, turning what you just told me into a real plan that actually protects your money, not just tracking it after the fact.`,
      "for me to help you, i need to set you up with a secure bank account. to create it, i need your email address, your date of birth, and your bvn or nin.",
      "your funds are secured by our banking partner, rubies microfinance bank, and regulated by the central bank of nigeria. udara never keeps hold of your id number, it's passed straight through to rubies once your account is created.",
      "tap below to fill it in securely, it never comes through as a chat message.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", text);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      text,
      user.id,
    );
    await this.sendKycFlow(user);
  }

  /** Stray free text during Account Creation — point back at the form instead of trying to parse it. */
  private async handleTrustMomentText(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const nudge =
      "please use the form above to share your bvn/nin, date of birth, and email, it's the secure way to do this. resending it now:";
    await this.appendMessage(sessionId, "assistant", nudge);
    await this.whatsapp.sendText(user.whatsappNumber, nudge, user.id);
    await this.sendKycFlow(user);
  }

  /**
   * Sends the KYC WhatsApp Flow. flowToken is freshly generated on every
   * send (initial send and every retry) so a resubmission can never be
   * confused with an earlier one. WHATSAPP_KYC_FLOW_ID unset is a dev-mode
   * escape hatch — loud warning, not a silent failure — since a Flow must be
   * created/published in the Meta Business Manager (or via the Graph API)
   * before it has an ID to send; see docs/whatsapp-flows/.
   */
  private async sendKycFlow(user: User): Promise<void> {
    const flowId = this.config.get<string>("WHATSAPP_KYC_FLOW_ID");
    if (!flowId) {
      this.logger.warn(
        "WHATSAPP_KYC_FLOW_ID is not set — cannot send the KYC form. See docs/whatsapp-flows/.",
      );
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "the identity-verification form isn't set up on this environment yet, a developer needs to publish it first.",
        user.id,
      );
      return;
    }

    await this.whatsapp.sendFlow({
      to: user.whatsappNumber,
      flowId,
      flowToken: randomUUID(),
      screenId: "KYC",
      headerText: "Verify your identity",
      bodyText:
        "Tap below to securely share your BVN or NIN, date of birth, and email. Takes under a minute.",
      ctaText: "Verify identity",
      userId: user.id,
    });
  }

  private async provisionRubiesAccount(
    user: User,
    sessionId: string,
    kyc: {
      firstName: string;
      middleName?: string;
      lastName: string;
      idType: "BVN" | "NIN";
      idNumber: string;
      email: string;
      dateOfBirth: string;
    },
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    try {
      // Rubies' create-wallet KYC match (>=90% similarity against the
      // BVN/NIN record) is against firstName/lastName only — its request
      // schema has no middle-name field, so kyc.middleName is stored on
      // User below but never sent here.
      const account = await this.rubies.provisionAccount({
        bvn: kyc.idType === "BVN" ? kyc.idNumber : undefined,
        nin: kyc.idType === "NIN" ? kyc.idNumber : undefined,
        firstName: kyc.firstName,
        lastName: kyc.lastName,
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
          legalFirstName: kyc.firstName,
          legalMiddleName: kyc.middleName,
          legalLastName: kyc.lastName,
          email: kyc.email,
          dateOfBirth: new Date(kyc.dateOfBirth),
          // Deliberately never writing bvn/nin to the User record — see the
          // account-creation copy above. The Flow submission is never
          // persisted to OnboardingSession either, so the raw ID number
          // only ever exists in memory for this one call.
        },
      });

      // Onboarding continues into Money Story next, not straight to
      // ACCOUNT_CREATED — that stage now fires much later, once the whole
      // script (money story, reflection, structured questions, plan review)
      // is actually done. See sendFundingInstructions.
      await this.advanceStage(sessionId, OnboardingStage.MONEY_STORY);

      const confirmText = [
        `your udara account has been created successfully 🎉 your account number is: ${account.accountNumber}.`,
        "pin this chat so you can send money here anytime.",
      ].join("\n\n");
      await this.appendMessage(sessionId, "assistant", confirmText);
      await this.chunkedMessenger.sendChunkedReply(
        user.whatsappNumber,
        confirmText,
        user.id,
      );

      await this.sendMoneyStoryQuestions(user, sessionId);
    } catch (err) {
      this.logger.warn(
        `Rubies provisionAccount failed for user ${user.id}: ${String(err)}`,
      );

      // Tell them plainly what happened and let them try again right away —
      // resending the form (fresh flow_token) rather than asking them to
      // free-type anything.
      const message = this.describeProvisioningFailure(err);
      await this.appendMessage(sessionId, "assistant", message);
      await this.whatsapp.sendText(user.whatsappNumber, message, user.id);
      await this.sendKycFlow(user);
    }
  }

  /**
   * Turns a provisioning failure into a message that's safe to show the
   * user. RubiesService's own thrown errors are already clean, user-facing
   * text (a KYC-mismatch reason from Rubies itself, or a generic "couldn't
   * reach Rubies") — those are shown as-is. A raw Prisma error is an
   * internal implementation detail and must never reach the user verbatim.
   * The specific, actionable case is a P2002 unique-constraint collision on
   * rubiesAccountId/rubiesAccountNumber: Rubies hands back an *existing*
   * account instead of creating a new one when the same BVN/NIN has already
   * been used to provision a different Udara user (common while testing
   * with one real identity across multiple numbers) — our schema correctly
   * refuses to link one Rubies account to two Udara users, but the
   * resulting DB error told the user nothing useful. Any other Prisma error
   * falls back to a generic message rather than leaking ORM/schema internals.
   */
  private describeProvisioningFailure(err: unknown): string {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        const target = err.meta?.target;
        const fields = Array.isArray(target) ? target : [];
        if (
          fields.includes("rubiesAccountId") ||
          fields.includes("rubiesAccountNumber")
        ) {
          return "that bvn/nin is already linked to a different udara account. if that's a different number of yours, message us from that whatsapp chat instead. if this looks wrong, let us know. here's the form if you'd like to try a different id:";
        }
      }
      return "that didn't go through, something on our end needs a look. here's the form to try again:";
    }

    const reason =
      err instanceof Error ? err.message : "rubies rejected the details";
    return `that didn't go through, ${reason}. let's try again, here's the form:`;
  }

  // =========================================================================
  // AI_REFLECTION — Stage 6: a recap built from fields already captured, no
  // new question asked, no model call needed. Auto-advances straight into
  // the first structured question, matching the script's own flow.
  // =========================================================================

  private async sendReflectionAndFirstStructuredQuestion(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    const quickQuestions = isRecord(extractedData.quickQuestions)
      ? extractedData.quickQuestions
      : {};
    const moneyStory = isRecord(extractedData.moneyStory)
      ? extractedData.moneyStory
      : {};

    const firstName = displayFirstNameOrThere(freshUser.name);
    const regret =
      typeof quickQuestions.spendingRegret === "string"
        ? quickQuestions.spendingRegret
        : "impulse spending";
    const goal =
      typeof moneyStory.statedGoal === "string"
        ? moneyStory.statedGoal
        : (freshUser.statedGoal ?? "your goal");
    const income = freshUser.monthlyIncome
      ? Number(freshUser.monthlyIncome).toLocaleString("en-NG")
      : "0";
    const city = freshUser.city ?? "";

    const reflection = [
      `thanks for sharing, ${firstName}. i have a better understanding now.`,
      `from what you told me: your biggest challenge is ${regret}. your goal is ${goal}. it looks like your biggest challenge isn't earning money, it's creating a system that protects your money when emotions take over.`,
      `based on everything you shared:\nincome: ₦${income}/month\nlocation: ${city}\nmain challenge: ${regret}\ngoal: ${goal}`,
      "now let's build your udara profile.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", reflection);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      reflection,
      user.id,
    );

    await this.advanceStage(sessionId, OnboardingStage.STRUCTURED_QUESTIONS);
    await this.sendStructuredQuestion(user, sessionId, 0);
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
        "that doesn't match the current question, here it is again.",
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
   * Computes the plan and presents it, then opens the Plan Review checkpoint
   * (Stage 8 — new vs. the old Kedu script, which didn't have one). Udara's
   * budgeting formula (50/30/20) is a single universal rule: 30% of monthly
   * income is the "wants" allowance Udara actively manages day to day — no
   * income-tier branching (the old GROW/RESTRICT posture and FLAT/PERCENTAGE
   * method distinctions are gone, this is deliberate, see AllowanceService's
   * matching change). Fixed /30 divisor, not calendar days-in-month, per the
   * script's own stated invariant that daily x 30 always equals the monthly
   * figure exactly, no exceptions.
   */
  private async finalizeStructuredQuestions(
    user: User,
    sessionId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const freshUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    const strictnessLevel = STRICTNESS_LEVEL_BY_SQ2_ID[answers.sq2] ?? 3;

    const WANTS_ALLOCATION_PCT = 0.3;
    const monthlyIncome = Number(freshUser.monthlyIncome ?? 0);
    const monthlyAllowance =
      Math.round((monthlyIncome * WANTS_ALLOCATION_PCT) / 1000) * 1000;
    const dailyLimit = Math.round(monthlyAllowance / 30);
    const weeklyLimit = dailyLimit * 7;

    await this.prisma.user.update({
      where: { id: user.id },
      data: { strictnessLevel },
    });

    await this.mergeExtractedData(sessionId, {
      structuredAnswers: answers,
      plan: { dailyLimit, weeklyLimit, monthlyAllowance },
    });
    await this.advanceStage(sessionId, OnboardingStage.PLAN_REVIEW);

    const firstName = displayFirstNameOrThere(freshUser.name);
    const planText = [
      `${firstName}, i have enough to build your first udara plan.`,
      `here's how i'm splitting your ₦${monthlyIncome.toLocaleString("en-NG")}. the 50/30/20 principle means 50% goes to needs like rent and bills, 30% goes to wants like food, shopping, and going out, and 20% goes to savings.`,
      `that 30% wants portion, ₦${monthlyAllowance.toLocaleString("en-NG")}, is what i'll actively help you manage day to day:\n\ndaily spending limit: ₦${dailyLimit.toLocaleString("en-NG")}\nweekly spending limit: ₦${weeklyLimit.toLocaleString("en-NG")}\nmonthly spending allowance: ₦${monthlyAllowance.toLocaleString("en-NG")}`,
      "spending window: 11am to 8pm. outside that window, transfers are locked, no exceptions. within it, if you go over your daily limit, we'll talk through it before anything moves.",
    ].join("\n\n");
    await this.appendMessage(sessionId, "assistant", planText);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      planText,
      user.id,
    );

    const checkpoint =
      "what do you think, does this feel right, or want to adjust anything?";
    await this.appendMessage(sessionId, "assistant", checkpoint);
    await this.whatsapp.sendInteractiveButtons(
      user.whatsappNumber,
      checkpoint,
      [
        { id: PLAN_REVIEW_FEELS_RIGHT, title: "Feels right" },
        { id: PLAN_REVIEW_ADJUST, title: "Let's adjust" },
      ],
      user.id,
    );
  }

  // =========================================================================
  // PLAN_REVIEW — Stage 8's "does this feel right?" checkpoint.
  // =========================================================================

  private async handlePlanReviewChoice(
    user: User,
    buttonId: string,
  ): Promise<void> {
    const session = await this.getOrStartSession(user.id);

    if (buttonId === PLAN_REVIEW_ADJUST) {
      await this.mergeExtractedData(session.id, {
        awaitingAdjustmentNote: true,
      });
      const ask =
        "tell me what you'd like different, i'll take it into account.";
      await this.appendMessage(session.id, "assistant", ask);
      await this.whatsapp.sendText(user.whatsappNumber, ask, user.id);
      return; // stays on PLAN_REVIEW — next text handled by handlePlanReviewText
    }

    if (buttonId === PLAN_REVIEW_FEELS_RIGHT) {
      await this.sendFundingInstructions(user, session.id);
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "tap one of the options above.",
      user.id,
    );
  }

  /**
   * "Let's adjust"'s free-text follow-up. v1 scope: the note is acknowledged
   * and kept on the session for reference, not used to actually recompute
   * the plan yet — there's no plan-editing engine built. Proceeds straight
   * to funding, same as "Feels right." A real adjustment flow (re-deriving
   * daily/weekly/monthly figures from a described change) is a documented
   * fast-follow, not built now.
   */
  private async handlePlanReviewText(
    user: User,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};

    if (!extractedData.awaitingAdjustmentNote) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "tap one of the options above.",
        user.id,
      );
      return;
    }

    await this.mergeExtractedData(sessionId, {
      adjustmentNote: text,
      awaitingAdjustmentNote: false,
    });
    const ack =
      "got it, noted. you can always fine-tune this with me later, let's get your account funded for now.";
    await this.appendMessage(sessionId, "assistant", ack);
    await this.whatsapp.sendText(user.whatsappNumber, ack, user.id);

    await this.sendFundingInstructions(user, sessionId);
  }

  /**
   * Stage 9. Advances to ACCOUNT_CREATED here (not at KYC time anymore) —
   * this is the point the onboarding *script* is actually done and the app
   * is just waiting on funding, matching what that stage name has always
   * meant to the rest of the app (RubiesWebhookController's ACCOUNT_CREATED
   * -> FUNDED transition, TransferConfirmationService's first-transaction
   * completion check).
   */
  private async sendFundingInstructions(
    user: User,
    sessionId: string,
  ): Promise<void> {
    const session = await this.prisma.onboardingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const extractedData = isRecord(session.extractedData)
      ? session.extractedData
      : {};
    const plan = isRecord(extractedData.plan)
      ? (extractedData.plan as { monthlyAllowance?: number })
      : {};
    const monthlyAllowance = plan.monthlyAllowance ?? 0;

    await this.advanceStage(sessionId, OnboardingStage.ACCOUNT_CREATED);

    const text = `your next step is to fund your udara account. send ₦${monthlyAllowance.toLocaleString("en-NG")} into this account, that's your full monthly spending allowance based on the plan we just built. once received, udara will automatically activate your spending plan.`;
    await this.appendMessage(sessionId, "assistant", text);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      text,
      user.id,
    );
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
    const quickQuestions = isRecord(extractedData.quickQuestions)
      ? extractedData.quickQuestions
      : {};

    const known: string[] = [];
    if (user.name) known.push(`name: ${user.name}`);
    if (user.city) known.push(`city: ${user.city}`);
    if (user.monthlyIncome)
      known.push(
        `monthly income: ~₦${Number(user.monthlyIncome).toLocaleString("en-NG")}`,
      );
    if (user.statedGoal) known.push(`stated goal: ${user.statedGoal}`);
    if (typeof quickQuestions.spendingRegret === "string")
      known.push(`why they came to udara: ${quickQuestions.spendingRegret}`);

    return {
      role: "system",
      content:
        known.length > 0
          ? `Already known about this user so far:\n${known.join("\n")}`
          : "Nothing confirmed about this user yet.",
    };
  }
}

/**
 * WhatsApp Flow's DatePicker component submits the chosen date as a string
 * epoch-millisecond timestamp, not a plain YYYY-MM-DD string — this decodes
 * that (with a literal-date fallback in case a future Flow version changes
 * the wire format) and returns YYYY-MM-DD, or null if it can't be parsed at
 * all (treated the same as "field missing" by the caller).
 */
function parseFlowDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = Number(raw);
  if (Number.isFinite(ms) && ms > 0) {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
