import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ChunkedMessengerService } from "./chunked-messenger.service";
import { CONVERSATION_LLM, LlmMessage, LlmService } from "../ai/llm.types";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { buildKeduSystemMessage } from "../ai/prompts/kedu-persona.prompts";
import { AllowanceService } from "../allowance/allowance.service";
import { WindowService } from "../allowance/window.service";
import {
  formatWatCalendarDate,
  formatWatClockTime,
} from "../common/wat-time.util";
import {
  ConversationPersona,
  ConversationSession,
  ConversationSessionStatus,
  LlmCallPurpose,
  Prisma,
  User,
} from "@prisma/client";

/**
 * General post-onboarding conversation — the fallback once a message
 * doesn't match one of the structured stopgap commands (transfer/manager/
 * summary, see parsers/text-command.parser.ts). Free-text, no tool call:
 * Kedu talking in its own voice, nothing here writes to User/Transaction/
 * anything financial — that only ever happens through the structured
 * commands or button confirms, per the guardrail pattern.
 */
@Injectable()
export class KeduChatService {
  private readonly logger = new Logger(KeduChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONVERSATION_LLM) private readonly llm: LlmService,
    private readonly llmLogger: LlmCallLoggerService,
    private readonly chunkedMessenger: ChunkedMessengerService,
    private readonly allowance: AllowanceService,
    private readonly windowService: WindowService,
  ) {}

  async handleMessage(user: User, text: string): Promise<void> {
    const session = await this.getOrCreateActiveSession(user.id);
    const history = await this.appendAndBuildHistory(session, "user", text);
    const liveFacts = await this.buildLiveFacts(user);

    const result = await this.llm.complete({
      messages: [buildKeduSystemMessage(liveFacts), ...history],
      purpose: LlmCallPurpose.CONVERSATION_REPLY,
      userId: user.id,
    });
    await this.llmLogger.log({
      userId: user.id,
      purpose: LlmCallPurpose.CONVERSATION_REPLY,
      result,
    });

    const reply =
      result.text ?? "hmm, lost my train of thought there, say that again?";
    await this.appendMessage(session.id, "assistant", reply);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      reply,
      user.id,
    );
  }

  /**
   * The grounding block handed to the model on every turn. Without it the
   * persona has no clock and no figures, so when a user asks "is my window
   * open" or "what's left" it produces something plausible-sounding and
   * wrong, and contradicts itself across consecutive messages. The prompt
   * describes the *rule* ("11AM to 8PM"); only this supplies the *facts*.
   *
   * Time is read in WAT explicitly (never the process's local timezone —
   * see wat-time.util), and the allowance figures come from the same
   * AllowanceService.getRemainingSummary the "Limits" menu action uses, so
   * chat and the deterministic surface can never quote different numbers
   * for the same moment.
   *
   * Best-effort: a failure here degrades the reply's specificity, it never
   * blocks it. The clock line is built first and separately because it
   * cannot fail, and it's the part this bug was actually about.
   */
  private async buildLiveFacts(user: User): Promise<string> {
    const now = new Date();
    const lines = [
      "Live facts, computed just now. These are real values, not estimates. Use these exact numbers and never guess or substitute your own:",
      `- Current date: ${formatWatCalendarDate(now)} (WAT)`,
      `- Current time: ${formatWatClockTime(now)} WAT (Udara operates in WAT only, there is no other timezone)`,
      `- The spending window is ${user.windowStartHour}:00 to ${user.windowEndHour}:00 WAT`,
    ];

    if (user.disciplineExitedAt) {
      lines.push(
        "- This user has exited restrictions: the spending window and override fees do not apply to them at all. Do not tell them they are locked out.",
      );
    } else if (
      this.windowService.isWithinWindow(
        user.windowStartHour,
        user.windowEndHour,
        now,
      )
    ) {
      lines.push(
        `- Window status right now: OPEN. It closes at ${user.windowEndHour}:00 WAT.`,
      );
    } else {
      const hoursUntil = this.windowService.hoursUntilWindowOpens(
        user.windowStartHour,
        now,
      );
      lines.push(
        `- Window status right now: CLOSED. It reopens at ${user.windowStartHour}:00 WAT, roughly ${hoursUntil}h from now. Transfers cannot go out until then.`,
      );
    }

    try {
      const { remainingToday, remainingWeek } =
        await this.allowance.getRemainingSummary(user.id);
      lines.push(
        `- Remaining allowance today: ₦${remainingToday.toLocaleString("en-NG")}`,
        `- Remaining allowance this week: ₦${remainingWeek.toLocaleString("en-NG")}`,
      );
    } catch (err) {
      // Non-fatal: the reply just won't have figures in it, and the voice
      // rules already require saying "i don't know" rather than inventing.
      this.logger.warn(
        `Could not load allowance figures for user ${user.id}'s chat context: ${String(err)}`,
      );
      lines.push(
        "- Allowance figures are unavailable this turn. If asked about balance or what's left, say you can't pull it up right now, do NOT estimate.",
      );
    }

    return lines.join("\n");
  }

  private async getOrCreateActiveSession(
    userId: string,
  ): Promise<ConversationSession> {
    const existing = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (existing) return existing;

    return this.prisma.conversationSession.create({
      data: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
        messages: [],
      },
    });
  }

  private async appendMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ) {
    const session = await this.prisma.conversationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const messages = Array.isArray(session.messages) ? session.messages : [];
    messages.push({ role, content, at: new Date().toISOString() });
    return this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { messages: messages as Prisma.InputJsonValue },
    });
  }

  private async appendAndBuildHistory(
    session: ConversationSession,
    role: "user" | "assistant",
    content: string,
  ): Promise<LlmMessage[]> {
    const updated = await this.appendMessage(session.id, role, content);
    const messages = Array.isArray(updated.messages) ? updated.messages : [];
    return messages.slice(-20).map((raw) => {
      const m = raw as { role?: string; content?: string };
      return {
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      };
    });
  }
}
