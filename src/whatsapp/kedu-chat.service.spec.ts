import { KeduChatService } from "./kedu-chat.service";
import { ConversationPersona, ConversationSessionStatus } from "@prisma/client";

describe("KeduChatService", () => {
  let prisma: {
    conversationSession: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
  };
  let llm: { complete: jest.Mock };
  let llmLogger: { log: jest.Mock };
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let service: KeduChatService;

  const user = { id: "user-1", whatsappNumber: "234801" };

  beforeEach(() => {
    prisma = {
      conversationSession: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };
    llm = {
      complete: jest.fn().mockResolvedValue({
        text: "yo",
        raw: {},
        latencyMs: 1,
        provider: "stub",
        model: "stub",
      }),
    };
    llmLogger = { log: jest.fn().mockResolvedValue({ id: "log-1" }) };
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    service = new KeduChatService(
      prisma as any,
      llm as any,
      llmLogger as any,
      chunkedMessenger as any,
    );
  });

  it("creates a new ACTIVE KEDU session if none exists", async () => {
    prisma.conversationSession.findFirst.mockResolvedValue(null);
    prisma.conversationSession.create.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.findUniqueOrThrow.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.update.mockResolvedValue({
      id: "session-1",
      messages: [{ role: "user", content: "hey" }],
    });

    await service.handleMessage(user as any, "hey");

    expect(prisma.conversationSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          persona: ConversationPersona.KEDU,
          status: ConversationSessionStatus.ACTIVE,
        }),
      }),
    );
  });

  it("reuses an existing ACTIVE session instead of creating a new one", async () => {
    prisma.conversationSession.findFirst.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.findUniqueOrThrow.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.update.mockResolvedValue({
      id: "session-1",
      messages: [{ role: "user", content: "hey" }],
    });

    await service.handleMessage(user as any, "hey");

    expect(prisma.conversationSession.create).not.toHaveBeenCalled();
  });

  it("sends the LLM's reply via ChunkedMessenger and logs the call", async () => {
    prisma.conversationSession.findFirst.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.findUniqueOrThrow.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.update.mockResolvedValue({
      id: "session-1",
      messages: [{ role: "user", content: "hey" }],
    });
    llm.complete.mockResolvedValue({
      text: "sup",
      raw: {},
      latencyMs: 1,
      provider: "stub",
      model: "stub",
    });

    await service.handleMessage(user as any, "hey");

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      "234801",
      "sup",
      "user-1",
    );
    expect(llmLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        purpose: "CONVERSATION_REPLY",
      }),
    );
  });

  it("falls back to a plain nudge if the model returns no text", async () => {
    prisma.conversationSession.findFirst.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.findUniqueOrThrow.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    prisma.conversationSession.update.mockResolvedValue({
      id: "session-1",
      messages: [],
    });
    llm.complete.mockResolvedValue({
      raw: {},
      latencyMs: 1,
      provider: "stub",
      model: "stub",
    });

    await service.handleMessage(user as any, "hey");

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      "234801",
      expect.any(String),
      "user-1",
    );
  });
});
