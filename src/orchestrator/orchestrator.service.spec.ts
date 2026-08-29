import { OrchestratorService } from "./orchestrator.service";
import { ActionValidatorService } from "./action-validator.service";
import {
  LlmCallPurpose,
  OnboardingStage,
  TransactionStatus,
} from "@prisma/client";
import { ORCHESTRATOR_LLM_TIMEOUT_MS } from "./orchestrator.types";

describe("OrchestratorService", () => {
  let prisma: any;
  let llm: { complete: jest.Mock };
  let llmLogger: { log: jest.Mock; markApplied: jest.Mock };
  let allowance: { getRemainingSummary: jest.Mock; evaluateSpend: jest.Mock };
  let windowService: {
    isWithinWindow: jest.Mock;
    hoursUntilWindowOpens: jest.Mock;
  };
  let service: OrchestratorService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: "0123456789",
    windowStartHour: 11,
    windowEndHour: 20,
    disciplineExitedAt: null,
    name: "Ada",
  } as any;

  beforeEach(() => {
    prisma = {
      conversationSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: "sess-1",
          messages: [],
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: "sess-1",
          messages: [],
        }),
        create: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: "sess-1", messages: data.messages }),
          ),
      },
      transferDraft: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    llm = { complete: jest.fn() };
    llmLogger = {
      log: jest.fn().mockResolvedValue({ id: "log-1" }),
      markApplied: jest.fn().mockResolvedValue(undefined),
    };
    allowance = {
      getRemainingSummary: jest
        .fn()
        .mockResolvedValue({ remainingToday: 5000, remainingWeek: 20000 }),
      evaluateSpend: jest.fn().mockResolvedValue({ type: "NORMAL" }),
    };
    windowService = {
      isWithinWindow: jest.fn().mockReturnValue(true),
      hoursUntilWindowOpens: jest.fn().mockReturnValue(0),
    };

    service = new OrchestratorService(
      prisma,
      llm as any,
      llmLogger as any,
      allowance as any,
      windowService as any,
      new ActionValidatorService(),
      { get: () => "stub" } as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("validates a high-confidence surface proposal and marks applied", async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "lets send that",
          action: {
            type: "show_surface",
            surface_key: "balance_read",
            confidence: "high",
          },
        },
      },
      latencyMs: 100,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "what's my balance");

    expect(result.ok).toBe(true);
    expect(result.surfaceKey).toBe("balance_read");
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
        forceTool: true,
        maxTokens: 512,
      }),
    );
    expect(llmLogger.markApplied).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({
        proposed: expect.any(Object),
        validated: expect.objectContaining({
          surfaceKey: "balance_read",
        }),
      }),
      true,
    );
  });

  it("returns ok:false on LLM timeout", async () => {
    jest.useFakeTimers();
    llm.complete.mockReturnValue(new Promise(() => undefined));

    const pending = service.handleMessage(user, "hello");
    await jest.advanceTimersByTimeAsync(ORCHESTRATOR_LLM_TIMEOUT_MS + 600);
    await expect(pending).resolves.toEqual({ message: "", ok: false });

    jest.useRealTimers();
  });

  it("returns ok:false when tool call is missing", async () => {
    llm.complete.mockResolvedValue({
      text: "oops plain text",
      latencyMs: 50,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "hi");

    expect(result.ok).toBe(false);
    expect(llmLogger.markApplied).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ rejectionReason: "parse_failed" }),
      false,
    );
  });

  it("includes Active mode: transfer_wizard in live facts when a draft is open", async () => {
    prisma.transferDraft.findFirst.mockResolvedValue({
      id: "draft-1",
      step: "AWAITING_AMOUNT",
      amount: null,
      accountNumber: "8100368023",
      bankName: "Opay",
      bankCode: "100004",
    });
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "got it",
          action: {
            type: "fill_wizard",
            confidence: "high",
            extracted_hints: { amount: 800 },
          },
        },
      },
      latencyMs: 80,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "800");

    expect(result.ok).toBe(true);
    expect(result.actionType).toBe("fill_wizard");
    expect(result.extractedHints).toEqual({ amount: 800 });
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Active mode: transfer_wizard"),
          }),
        ]),
      }),
    );
  });

  it("parses propose_turn when the model flattens action.type onto the root", async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "hey",
          type: "reply_only",
        },
      },
      latencyMs: 40,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "Hello Udara");
    expect(result.ok).toBe(true);
    expect(result.actionType).toBe("reply_only");
    expect(result.surfaceKey).toBeUndefined();
  });

  it("treats a leftover draft as free after a later completed send", async () => {
    const draftCreated = new Date("2026-08-26T15:00:00Z");
    const sentAt = new Date("2026-08-26T16:14:00Z");
    prisma.transferDraft.findFirst.mockResolvedValue({
      id: "draft-stale",
      step: "AWAITING_ACCOUNT_NUMBER",
      amount: 800,
      accountNumber: null,
      bankName: "Opay",
      createdAt: draftCreated,
    });
    prisma.transaction.findFirst.mockImplementation(
      async ({ where }: { where: { status?: unknown } }) => {
        if (where.status === TransactionStatus.EXECUTED) {
          return {
            amount: 800,
            executedAt: sentAt,
            recipient: { accountName: "SAMUEL DAVID EGWU" },
          };
        }
        return null;
      },
    );
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "you're welcome",
          action: { type: "reply_only" },
        },
      },
      latencyMs: 40,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "thank you");

    expect(result.ok).toBe(true);
    expect(result.actionType).toBe("reply_only");
    expect(prisma.transferDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "draft-stale" }),
      }),
    );
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringMatching(
              /Active mode: free[\s\S]*Last completed transfer: ₦800 to SAMUEL DAVID EGWU/,
            ),
          }),
        ]),
      }),
    );
  });

  it("does not open the wizard on a vague send; stores a spend check instead", async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "on it.",
          action: {
            type: "show_surface",
            surface_key: "transfer_wizard",
            confidence: "high",
            extracted_hints: { amount: 800, bank_name: "opay" },
          },
        },
      },
      latencyMs: 40,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "send 800 to opay");

    expect(result.ok).toBe(true);
    expect(result.actionType).toBe("reply_only");
    expect(result.surfaceKey).toBeUndefined();
    expect(result.message).toMatch(/what's it actually for/i);
    expect(prisma.conversationSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextData: expect.objectContaining({
            spendCheck: expect.objectContaining({ amount: 800 }),
          }),
        }),
      }),
    );
  });

  it("does not open the wizard on a purpose-stated first send", async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: {
          message: "on it.",
          action: {
            type: "show_surface",
            surface_key: "transfer_wizard",
            confidence: "high",
            extracted_hints: { amount: 5000, label_hint: "RENT" },
          },
        },
      },
      latencyMs: 40,
      provider: "stub",
      model: "stub",
    });

    const result = await service.handleMessage(user, "send 5k to my landlord");

    expect(result.actionType).toBe("reply_only");
    expect(result.surfaceKey).toBeUndefined();
  });

  it("attaches a photo only when the conversation provider can see it", async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: "propose_turn",
        arguments: { message: "got the photo", action: { type: "reply_only" } },
      },
      latencyMs: 20,
      provider: "stub",
      model: "stub",
    });

    await service.handleMessage(user, "this receipt", {
      image: { mimeType: "image/jpeg", data: "abc" },
    });

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringMatching(/not visible to the model/),
          }),
        ]),
      }),
    );
  });
});
