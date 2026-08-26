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
      applyHintsToDraft: jest.fn().mockResolvedValue(undefined),
      cancelActiveSurfaces: jest.fn().mockResolvedValue(undefined),
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
      actionType: 'show_surface',
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

  it('passes sanitized transfer hints into startTransferWizard without session recovery', async () => {
    await executor.execute(user, {
      message: 'lets send that',
      actionType: 'show_surface',
      surfaceKey: 'transfer_wizard',
      extractedHints: {
        amount: 15000,
        accountNumber: '0123456789',
        bankName: 'GTBank',
        labelHint: 'RENT',
      },
      ok: true,
    });

    expect(accountActions.startTransferWizard).toHaveBeenCalledWith(
      user,
      {
        amount: 15000,
        accountNumber: '0123456789',
        bankName: 'GTBank',
        labelHint: 'RENT',
      },
      { recoverFromSession: false },
    );
  });

  it('fill_wizard applies hints to the active draft', async () => {
    await executor.execute(user, {
      message: 'got it',
      actionType: 'fill_wizard',
      extractedHints: { amount: 800 },
      ok: true,
    });

    expect(accountActions.applyHintsToDraft).toHaveBeenCalledWith(user, {
      amount: 800,
    });
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it('cancel_surface cancels active wizard / pending confirm', async () => {
    await executor.execute(user, {
      message: 'okay, dropping that',
      actionType: 'cancel_surface',
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).toHaveBeenCalledWith(user);
  });

  it('runs failure SOP: apology without dumping the menu', async () => {
    await executor.execute(user, { message: '', ok: false });

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      '234801',
      ORCHESTRATOR_FAILURE_MESSAGE,
      'user-1',
    );
    expect(accountActions.sendMainMenu).not.toHaveBeenCalled();
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it('show_surface for a non-transfer surface cancels any active wizard first', async () => {
    await executor.execute(user, {
      message: 'checking your limits',
      actionType: 'show_surface',
      surfaceKey: 'limits_read',
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).toHaveBeenCalledWith(user);
    expect(accountActions.sendLimitsStatus).toHaveBeenCalledWith(user);
  });

  it('show_surface transfer_wizard does not cancel first', async () => {
    await executor.execute(user, {
      message: 'lets send that',
      actionType: 'show_surface',
      surfaceKey: 'transfer_wizard',
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).not.toHaveBeenCalled();
    expect(accountActions.startTransferWizard).toHaveBeenCalled();
  });
});
