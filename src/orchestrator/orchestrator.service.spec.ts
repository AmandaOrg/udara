import { OrchestratorService } from './orchestrator.service';
import { ActionValidatorService } from './action-validator.service';
import { LlmCallPurpose, OnboardingStage } from '@prisma/client';
import { ORCHESTRATOR_LLM_TIMEOUT_MS } from './orchestrator.types';

describe('OrchestratorService', () => {
  let prisma: any;
  let llm: { complete: jest.Mock };
  let llmLogger: { log: jest.Mock; markApplied: jest.Mock };
  let allowance: { getRemainingSummary: jest.Mock };
  let windowService: {
    isWithinWindow: jest.Mock;
    hoursUntilWindowOpens: jest.Mock;
  };
  let service: OrchestratorService;

  const user = {
    id: 'user-1',
    whatsappNumber: '234801',
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: '0123456789',
    windowStartHour: 11,
    windowEndHour: 20,
    disciplineExitedAt: null,
    name: 'Ada',
  } as any;

  beforeEach(() => {
    prisma = {
      conversationSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-1',
          messages: [],
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'sess-1',
          messages: [],
        }),
        create: jest.fn(),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'sess-1', messages: data.messages }),
        ),
      },
      transferDraft: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    llm = { complete: jest.fn() };
    llmLogger = {
      log: jest.fn().mockResolvedValue({ id: 'log-1' }),
      markApplied: jest.fn().mockResolvedValue(undefined),
    };
    allowance = {
      getRemainingSummary: jest
        .fn()
        .mockResolvedValue({ remainingToday: 5000, remainingWeek: 20000 }),
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
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('validates a high-confidence surface proposal and marks applied', async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: 'propose_turn',
        arguments: {
          message: 'lets send that',
          action: {
            type: 'show_surface',
            surface_key: 'transfer_wizard',
            confidence: 'high',
            extracted_hints: { amount: 15000 },
          },
        },
      },
      latencyMs: 100,
      provider: 'stub',
      model: 'stub',
    });

    const result = await service.handleMessage(user, 'send 15k to landlord');

    expect(result.ok).toBe(true);
    expect(result.surfaceKey).toBe('transfer_wizard');
    expect(result.extractedHints).toEqual({ amount: 15000 });
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
        forceTool: true,
        maxTokens: 1024,
      }),
    );
    expect(llmLogger.markApplied).toHaveBeenCalledWith(
      'log-1',
      expect.objectContaining({
        proposed: expect.any(Object),
        validated: expect.objectContaining({
          surfaceKey: 'transfer_wizard',
        }),
      }),
      true,
    );
  });

  it('returns ok:false on LLM timeout', async () => {
    jest.useFakeTimers();
    llm.complete.mockReturnValue(new Promise(() => undefined));

    const pending = service.handleMessage(user, 'hello');
    await jest.advanceTimersByTimeAsync(ORCHESTRATOR_LLM_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ message: '', ok: false });

    jest.useRealTimers();
  });

  it('returns ok:false when tool call is missing', async () => {
    llm.complete.mockResolvedValue({
      text: 'oops plain text',
      latencyMs: 50,
      provider: 'stub',
      model: 'stub',
    });

    const result = await service.handleMessage(user, 'hi');

    expect(result.ok).toBe(false);
    expect(llmLogger.markApplied).toHaveBeenCalledWith(
      'log-1',
      expect.objectContaining({ rejectionReason: 'parse_failed' }),
      false,
    );
  });

  it('includes Active mode: transfer_wizard in live facts when a draft is open', async () => {
    prisma.transferDraft.findFirst.mockResolvedValue({
      id: 'draft-1',
      step: 'AWAITING_AMOUNT',
      amount: null,
      accountNumber: '8100368023',
      bankName: 'Opay',
      bankCode: '100004',
    });
    llm.complete.mockResolvedValue({
      toolCall: {
        name: 'propose_turn',
        arguments: {
          message: 'got it',
          action: {
            type: 'fill_wizard',
            confidence: 'high',
            extracted_hints: { amount: 800 },
          },
        },
      },
      latencyMs: 80,
      provider: 'stub',
      model: 'stub',
    });

    const result = await service.handleMessage(user, '800');

    expect(result.ok).toBe(true);
    expect(result.actionType).toBe('fill_wizard');
    expect(result.extractedHints).toEqual({ amount: 800 });
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Active mode: transfer_wizard'),
          }),
        ]),
      }),
    );
  });

  it('parses propose_turn when the model flattens action.type onto the root', async () => {
    llm.complete.mockResolvedValue({
      toolCall: {
        name: 'propose_turn',
        arguments: {
          message: 'hey',
          type: 'reply_only',
        },
      },
      latencyMs: 40,
      provider: 'stub',
      model: 'stub',
    });

    const result = await service.handleMessage(user, 'Hello Udara');
    expect(result.ok).toBe(true);
    expect(result.actionType).toBe('reply_only');
    expect(result.surfaceKey).toBeUndefined();
  });
});
