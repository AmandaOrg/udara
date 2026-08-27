import { ActionValidatorService } from './action-validator.service';
import { ProposedTurn } from './orchestrator.types';
import { SurfaceDefinition } from './surface-registry';
import { OnboardingStage } from '@prisma/client';

describe('ActionValidatorService', () => {
  const validator = new ActionValidatorService();
  const user = {
    id: 'user-1',
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: '0123456789',
  } as any;

  const eligible: SurfaceDefinition[] = [
    {
      key: 'transfer_wizard',
      kind: 'wizard',
      description: 'Send money',
      isEligible: () => true,
    },
    {
      key: 'balance_read',
      kind: 'text',
      description: 'Balance',
      isEligible: () => true,
    },
  ];

  function proposal(
    overrides: Partial<ProposedTurn['action']> & { message?: string },
  ): ProposedTurn {
    const { message, ...action } = overrides;
    return {
      message: message ?? 'pulling that up',
      action: {
        type: 'show_surface',
        ...action,
      },
    };
  }

  const sendNow = 'send 15k to my landlord';

  it('passes reply_only with ok true and no surface', () => {
    const result = validator.validate(
      {
        message: 'hey',
        action: { type: 'reply_only' },
      },
      user,
      eligible,
    );
    expect(result).toEqual({
      message: 'hey',
      actionType: 'reply_only',
      ok: true,
    });
  });

  it('launches surface when confidence is high and key is eligible', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: {
          amount: 15000,
          account_number: '0123456789',
          bank_name: 'GTBank',
          label_hint: 'RENT',
        },
      }),
      user,
      eligible,
      sendNow,
    );
    expect(result.ok).toBe(true);
    expect(result.actionType).toBe('show_surface');
    expect(result.surfaceKey).toBe('transfer_wizard');
    expect(result.extractedHints).toEqual({
      amount: 15000,
      accountNumber: '0123456789',
      bankName: 'GTBank',
      labelHint: 'RENT',
    });
  });

  it('strips invalid transfer hints but keeps valid ones', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: {
          amount: 5000,
          account_number: '123',
          bank_name: 'GTBank',
        },
      }),
      user,
      eligible,
      sendNow,
    );
    expect(result.extractedHints).toEqual({
      amount: 5000,
      bankName: 'GTBank',
    });
  });

  it('launches the wizard when reply_only still extracted a ready send', () => {
    const result = validator.validate(
      {
        message: "let's get that ₦200 transfer to Opay ready.",
        action: {
          type: 'reply_only',
          extracted_hints: {
            amount: 200,
            account_number: '8100368023',
            bank_name: 'opay',
          },
        },
      },
      user,
      eligible,
      'lets make a trasfer of 200 to 8100368023, opay, for food',
    );
    expect(result.actionType).toBe('show_surface');
    expect(result.surfaceKey).toBe('transfer_wizard');
    expect(result.extractedHints).toEqual({
      amount: 200,
      accountNumber: '8100368023',
      bankName: 'opay',
    });
  });

  it('does not drop a ready transfer just because confidence is medium', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'medium',
        extracted_hints: {
          amount: 200,
          account_number: '8100368023',
          bank_name: 'opay',
        },
        message: "let's get that ready",
      }),
      user,
      eligible,
      'i want to transfer 200 to 8100368023, opay for rent',
    );
    expect(result.surfaceKey).toBe('transfer_wizard');
    expect(result.actionType).toBe('show_surface');
  });

  it('accepts fill_wizard with sanitized hints', () => {
    const result = validator.validate(
      {
        message: 'got it',
        action: {
          type: 'fill_wizard',
          confidence: 'high',
          extracted_hints: { amount: 800, account_number: 'bad' },
        },
      },
      user,
      eligible,
    );
    expect(result).toEqual({
      message: 'got it',
      actionType: 'fill_wizard',
      extractedHints: { amount: 800 },
      ok: true,
    });
  });

  it('accepts cancel_surface at high confidence', () => {
    const result = validator.validate(
      {
        message: 'cool, checking your budget instead',
        action: { type: 'cancel_surface', confidence: 'high' },
      },
      user,
      eligible,
    );
    expect(result).toEqual({
      message: 'cool, checking your budget instead',
      actionType: 'cancel_surface',
      ok: true,
    });
  });

  it('downgrades medium confidence to reply_only', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'medium',
        message: 'want me to open the transfer form?',
      }),
      user,
      eligible,
    );
    expect(result).toEqual({
      message: 'want me to open the transfer form?',
      actionType: 'reply_only',
      ok: true,
    });
    expect(result.surfaceKey).toBeUndefined();
  });

  it('treats missing confidence as medium (text only)', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'balance_read',
        message: 'checking now',
      }),
      user,
      eligible,
    );
    expect(result.surfaceKey).toBeUndefined();
    expect(result.actionType).toBe('reply_only');
    expect(result.ok).toBe(true);
    expect(result.message).toBe('checking now');
  });

  it('downgrades unknown surface key to reply_only', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'kyc_verification',
        confidence: 'high',
        message: 'lets do kyc',
      }),
      user,
      eligible,
    );
    expect(result.surfaceKey).toBeUndefined();
    expect(result.actionType).toBe('reply_only');
    expect(result.message).toBe('lets do kyc');
  });

  it('downgrades show_surface with no surface_key', () => {
    const result = validator.validate(
      proposal({ confidence: 'high', message: 'oops' }),
      user,
      eligible,
    );
    expect(result.surfaceKey).toBeUndefined();
    expect(result.actionType).toBe('reply_only');
  });

  it('does not restart a transfer on thank you even if hints are present', () => {
    const result = validator.validate(
      {
        message: "you're welcome",
        action: {
          type: 'show_surface',
          surface_key: 'transfer_wizard',
          confidence: 'high',
          extracted_hints: {
            amount: 800,
            bank_name: 'opay',
          },
        },
      },
      user,
      eligible,
      'thank you',
    );
    expect(result.actionType).toBe('reply_only');
    expect(result.surfaceKey).toBeUndefined();
  });

  it('does not restart a transfer when the user says it already went through', async () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: { amount: 800, bank_name: 'opay' },
        message: "i haven't sent anything yet",
      }),
      user,
      eligible,
      "you've done the transfers already",
    );
    expect(result.actionType).toBe('reply_only');
    expect(result.surfaceKey).toBeUndefined();
  });

  it('still launches transfer_wizard on a high-confidence yes after a send prompt', async () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: { amount: 800, bank_name: 'opay' },
      }),
      user,
      eligible,
      'yes',
    );
    expect(result.actionType).toBe('show_surface');
    expect(result.surfaceKey).toBe('transfer_wizard');
  });

  it('pauses a vague send for a spend check instead of launching the wizard', async () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: { amount: 800, bank_name: 'opay' },
        message: 'on it.',
      }),
      user,
      eligible,
      'send 800 to opay',
    );
    expect(result.actionType).toBe('reply_only');
    expect(result.surfaceKey).toBeUndefined();
  });

  it('launches after a spend check when they say what it is for', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: { amount: 800, bank_name: 'opay', label_hint: 'FOOD' },
      }),
      user,
      eligible,
      "it's for food",
      { spendCheckPending: true },
    );
    expect(result.actionType).toBe('show_surface');
    expect(result.surfaceKey).toBe('transfer_wizard');
  });
});
