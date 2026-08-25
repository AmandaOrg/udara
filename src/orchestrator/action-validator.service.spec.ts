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

  it('passes reply_only with ok true and no surface', () => {
    const result = validator.validate(
      {
        message: 'hey',
        action: { type: 'reply_only' },
      },
      user,
      eligible,
    );
    expect(result).toEqual({ message: 'hey', ok: true });
  });

  it('launches surface when confidence is high and key is eligible', () => {
    const result = validator.validate(
      proposal({
        surface_key: 'transfer_wizard',
        confidence: 'high',
        extracted_hints: { amount: 15000 },
      }),
      user,
      eligible,
    );
    expect(result.ok).toBe(true);
    expect(result.surfaceKey).toBe('transfer_wizard');
    expect(result.extractedHints).toEqual({ amount: 15000 });
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
    expect(result.message).toBe('lets do kyc');
  });

  it('downgrades show_surface with no surface_key', () => {
    const result = validator.validate(
      proposal({ confidence: 'high', message: 'oops' }),
      user,
      eligible,
    );
    expect(result.surfaceKey).toBeUndefined();
  });
});
