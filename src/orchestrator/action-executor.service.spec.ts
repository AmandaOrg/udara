import { ActionExecutorService } from './action-executor.service';
import { ORCHESTRATOR_FAILURE_MESSAGE } from './orchestrator.types';
import { OnboardingStage } from '@prisma/client';

describe('ActionExecutorService', () => {
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let accountActions: Record<string, jest.Mock>;
  let spendSummary: {
    getWeeklySummary: jest.Mock;
    formatAsText: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock };
  let executor: ActionExecutorService;

  const user = {
    id: 'user-1',
    whatsappNumber: '234801',
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: '0123456789',
  } as any;

  beforeEach(() => {
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    accountActions = {
      sendBalance: jest.fn().mockResolvedValue(undefined),
      sendLimitsStatus: jest.fn().mockResolvedValue(undefined),
      sendAccountDetails: jest.fn().mockResolvedValue(undefined),
      startTransferWizard: jest.fn().mockResolvedValue(undefined),
      sendMainMenu: jest.fn().mockResolvedValue(undefined),
    };
    spendSummary = {
      getWeeklySummary: jest.fn().mockResolvedValue({}),
      formatAsText: jest.fn().mockReturnValue('summary'),
    };
    whatsapp = { sendText: jest.fn().mockResolvedValue({ waMessageId: 'w1' }) };

    executor = new ActionExecutorService(
      chunkedMessenger as any,
      accountActions as any,
      spendSummary as any,
      whatsapp as any,
    );
  });

  it('sends persona message then dispatches surface', async () => {
    await executor.execute(user, {
      message: 'pulling your balance up',
      surfaceKey: 'balance_read',
      ok: true,
    });

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      '234801',
      'pulling your balance up',
      'user-1',
    );
    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
  });

  it('passes amount hint into startTransferWizard', async () => {
    await executor.execute(user, {
      message: 'lets send that',
      surfaceKey: 'transfer_wizard',
      extractedHints: { amount: 15000, label_hint: 'RENT' },
      ok: true,
    });

    expect(accountActions.startTransferWizard).toHaveBeenCalledWith(user, {
      amount: 15000,
    });
  });

  it('runs failure SOP: apology + main menu', async () => {
    await executor.execute(user, { message: '', ok: false });

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      '234801',
      ORCHESTRATOR_FAILURE_MESSAGE,
      'user-1',
    );
    expect(accountActions.sendMainMenu).toHaveBeenCalledWith(user);
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
  });

  it('reply_only sends message without surface', async () => {
    await executor.execute(user, {
      message: 'I hear you',
      ok: true,
    });

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalled();
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
    expect(accountActions.sendMainMenu).not.toHaveBeenCalled();
  });
});
