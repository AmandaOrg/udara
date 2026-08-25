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
    llm.complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                toolCall: {
                  name: 'propose_turn',
                  arguments: {
                    message: 'late',
                    action: { type: 'reply_only' },
                  },
                },
                latencyMs: ORCHESTRATOR_LLM_TIMEOUT_MS + 1000,
                provider: 'stub',
                model: 'stub',
              }),
            ORCHESTRATOR_LLM_TIMEOUT_MS + 50,
          );
        }),
    );

    const result = await service.handleMessage(user, 'hello');

    expect(result).toEqual({ message: '', ok: false });
  }, 10000);

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
});
