import { Injectable } from '@nestjs/common';
import {
  ConversationPersona,
  ConversationSessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransferWizardHints } from '../orchestrator/transfer-hints.util';
import {
  extractTransferHintsFromText,
  mergeTransferHints,
} from './transfer-hints-from-text.util';

/**
 * Pulls transfer details the user already stated in recent chat turns.
 * Covers orchestrator failures, menu taps, and "I already sent that" replies.
 */
@Injectable()
export class TransferHintsRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async recoverForUser(userId: string): Promise<TransferWizardHints> {
    const session = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!session || !Array.isArray(session.messages)) {
      return {};
    }

    const userTexts = session.messages
      .filter((raw) => {
        const m = raw as { role?: string; content?: string };
        return m.role === 'user' && typeof m.content === 'string';
      })
      .map((raw) => String((raw as { content: string }).content))
      .slice(-15);

    const merged = mergeTransferHints(
      ...userTexts.map((text) => extractTransferHintsFromText(text)),
    );

    return merged;
  }
}
