import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ChunkedMessengerService } from "./chunked-messenger.service";
import { CONVERSATION_LLM, LlmMessage, LlmService } from "../ai/llm.types";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { buildKeduSystemMessage } from "../ai/prompts/kedu-persona.prompts";
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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONVERSATION_LLM) private readonly llm: LlmService,
    private readonly llmLogger: LlmCallLoggerService,
    private readonly chunkedMessenger: ChunkedMessengerService,
  ) {}

  async handleMessage(user: User, text: string): Promise<void> {
    const session = await this.getOrCreateActiveSession(user.id);
    const history = await this.appendAndBuildHistory(session, "user", text);

    const result = await this.llm.complete({
      messages: [buildKeduSystemMessage(), ...history],
      purpose: LlmCallPurpose.CONVERSATION_REPLY,
      userId: user.id,
    });
    await this.llmLogger.log({
      userId: user.id,
      purpose: LlmCallPurpose.CONVERSATION_REPLY,
      result,
    });

    const reply =
      result.text ?? "hmm, lost my train of thought there — say that again?";
    await this.appendMessage(session.id, "assistant", reply);
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      reply,
      user.id,
    );
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
