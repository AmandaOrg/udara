import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingStage } from '@prisma/client';

/**
 * The conversational AI slice of the app (see the AI-skill discussion):
 * each turn is (a) sent to the conversation model along with history, and
 * (b) the model is asked to return structured output when a stage's target
 * field looks confirmed — e.g. { field: "incomeType", value: "FOUNDER",
 * confidence: "confirmed" } — which this service then validates and writes.
 * The model never writes to User directly; this service is the only writer.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrStartSession(userId: string) {
    const latest = await this.prisma.onboardingSession.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) return latest;

    return this.prisma.onboardingSession.create({
      data: {
        userId,
        stage: OnboardingStage.DISCOVERY,
        messages: [],
      },
    });
  }

  async appendMessage(sessionId: string, role: 'user' | 'assistant', content: string) {
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

  async advanceStage(sessionId: string, nextStage: OnboardingStage) {
    return this.prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { stage: nextStage },
    });
  }

  // TODO: buildPrompt(stage) — per-stage system prompt (one question at a
  // time, push back gently on vague answers — PRD section 6 key principles).
  // TODO: extractStructuredField(session, modelResponse) — validate model's
  // structured-output claim before writing to User (never trust blindly).
}
