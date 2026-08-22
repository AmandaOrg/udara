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
  let allowance: { getRemainingSummary: jest.Mock };
  let windowService: {
    isWithinWindow: jest.Mock;
    hoursUntilWindowOpens: jest.Mock;
  };
  let service: KeduChatService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    windowStartHour: 11,
    windowEndHour: 20,
    disciplineExitedAt: null,
  };

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
    allowance = {
      getRemainingSummary: jest.fn().mockResolvedValue({
        allowance: {},
        remainingToday: 15000,
        remainingWeek: 45000,
      }),
    };
    windowService = {
      isWithinWindow: jest.fn().mockReturnValue(true),
      hoursUntilWindowOpens: jest.fn().mockReturnValue(13),
    };
    service = new KeduChatService(
      prisma as any,
      llm as any,
      llmLogger as any,
      chunkedMessenger as any,
      allowance as any,
      windowService as any,
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
  describe("live-facts grounding (the persona must never guess the clock)", () => {
    /** Returns the system message actually handed to the model. */
    async function systemMessageFor(
      userOverrides: Record<string, unknown> = {},
    ) {
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

      await service.handleMessage({ ...user, ...userOverrides } as any, "hey");

      const [{ messages }] = llm.complete.mock.calls[0];
      return messages[0].content as string;
    }

    it("always states the current WAT time, so the model never has to infer it", async () => {
      const content = await systemMessageFor();
      expect(content).toMatch(/Current time: \d{1,2}:\d{2}(am|pm) WAT/);
    });

    it("states the window is OPEN, with its closing hour, when it is", async () => {
      windowService.isWithinWindow.mockReturnValue(true);
      const content = await systemMessageFor();
      expect(content).toContain("Window status right now: OPEN");
      expect(content).toContain("closes at 20:00 WAT");
      expect(content).not.toContain("CLOSED");
    });

    it("states the window is CLOSED, with hours until reopen, when it is", async () => {
      windowService.isWithinWindow.mockReturnValue(false);
      windowService.hoursUntilWindowOpens.mockReturnValue(13);
      const content = await systemMessageFor();
      expect(content).toContain("Window status right now: CLOSED");
      expect(content).toContain("reopens at 11:00 WAT");
      expect(content).toContain("roughly 13h from now");
    });

    it("passes the real allowance figures through, matching the Limits surface", async () => {
      const content = await systemMessageFor();
      expect(content).toContain("Remaining allowance today: ₦15,000");
      expect(content).toContain("Remaining allowance this week: ₦45,000");
      expect(allowance.getRemainingSummary).toHaveBeenCalledWith("user-1");
    });

    it("tells the model restrictions are off for an exited user, rather than that they're locked out", async () => {
      const content = await systemMessageFor({
        disciplineExitedAt: new Date(),
      });
      expect(content).toContain("exited restrictions");
      expect(content).not.toContain("Window status right now");
      expect(windowService.isWithinWindow).not.toHaveBeenCalled();
    });

    it("still replies, and explicitly forbids estimating, if allowance lookup fails", async () => {
      allowance.getRemainingSummary.mockRejectedValue(new Error("db down"));
      const content = await systemMessageFor();
      expect(content).toContain("do NOT estimate");
      // The clock line is built before the failing lookup, so it survives.
      expect(content).toMatch(/Current time: \d{1,2}:\d{2}(am|pm) WAT/);
      expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalled();
    });
  });
});
