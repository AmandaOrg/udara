/**
 * In-memory Prisma stub for the orchestrator CLI dry-run.
 * Only implements conversationSession methods OrchestratorService needs.
 * Any other access throws — CLI must never touch real DB / money tables.
 */

import { Injectable } from "@nestjs/common";
import {
  ConversationPersona,
  ConversationSessionStatus,
  Prisma,
} from "@prisma/client";

type SessionRow = {
  id: string;
  userId: string;
  persona: ConversationPersona;
  status: ConversationSessionStatus;
  messages: unknown[];
  contextData: unknown;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class CliPrismaStub {
  private sessions = new Map<string, SessionRow>();
  private seq = 0;

  conversationSession = {
    findFirst: async (args: {
      where: {
        userId: string;
        persona: ConversationPersona;
        status: ConversationSessionStatus;
      };
      orderBy?: { updatedAt: "desc" | "asc" };
    }): Promise<SessionRow | null> => {
      const matches = [...this.sessions.values()].filter(
        (s) =>
          s.userId === args.where.userId &&
          s.persona === args.where.persona &&
          s.status === args.where.status,
      );
      matches.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return matches[0]
        ? { ...matches[0], messages: [...matches[0].messages] }
        : null;
    },

    create: async (args: {
      data: {
        userId: string;
        persona: ConversationPersona;
        status: ConversationSessionStatus;
        messages: Prisma.InputJsonValue;
      };
    }): Promise<SessionRow> => {
      this.seq += 1;
      const id = `cli-sess-${this.seq}`;
      const now = new Date();
      const row: SessionRow = {
        id,
        userId: args.data.userId,
        persona: args.data.persona,
        status: args.data.status,
        messages: Array.isArray(args.data.messages)
          ? [...(args.data.messages as unknown[])]
          : [],
        contextData: null,
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(id, row);
      return { ...row, messages: [...row.messages] };
    },

    findUniqueOrThrow: async (args: {
      where: { id: string };
    }): Promise<SessionRow> => {
      const row = this.sessions.get(args.where.id);
      if (!row) {
        throw new Error(`CLI prisma: session ${args.where.id} not found`);
      }
      return { ...row, messages: [...row.messages] };
    },

    update: async (args: {
      where: { id: string };
      data: {
        messages?: Prisma.InputJsonValue;
        contextData?: Prisma.InputJsonValue;
      };
    }): Promise<SessionRow> => {
      const row = this.sessions.get(args.where.id);
      if (!row) {
        throw new Error(`CLI prisma: session ${args.where.id} not found`);
      }
      if (args.data.messages !== undefined) {
        row.messages = Array.isArray(args.data.messages)
          ? [...(args.data.messages as unknown[])]
          : [];
      }
      if (args.data.contextData !== undefined) {
        row.contextData = args.data.contextData;
      }
      row.updatedAt = new Date();
      this.sessions.set(row.id, row);
      return { ...row, messages: [...row.messages] };
    },
  };

  transferDraft = {
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
  };

  transaction = {
    findFirst: async () => null,
  };
}
