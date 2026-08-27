import * as path from 'path';
import * as fs from 'fs';
import { ActionValidatorService } from '../action-validator.service';
import { ProposedTurn, ProposeActionType } from '../orchestrator.types';
import { SurfaceDefinition, SURFACE_REGISTRY } from '../surface-registry';
import { OnboardingStage } from '@prisma/client';

interface GoldenCase {
  test_case_id: string;
  history: Array<{ role: string; content: string }>;
  mock_proposal: ProposedTurn;
  eligible_surfaces: string[];
  expected_surface: string | null;
  expected_action_type?: ProposeActionType;
  expected_hints?: Record<string, unknown>;
  expected_confidence: 'high' | 'medium' | null;
  forbidden_surfaces: string[];
}

describe('Golden dialogues — validator contract', () => {
  const validator = new ActionValidatorService();
  const user = {
    id: 'user-1',
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: '0123456789',
  } as any;

  const fixturesPath = path.join(__dirname, 'golden-dialogues.json');
  const cases: GoldenCase[] = JSON.parse(
    fs.readFileSync(fixturesPath, 'utf8'),
  );

  it('loads a non-empty fixture set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it('every fixture has required schema fields', () => {
    for (const c of cases) {
      expect(c.test_case_id).toBeTruthy();
      expect(Array.isArray(c.history)).toBe(true);
      expect(c.mock_proposal?.action?.type).toBeTruthy();
      expect(Array.isArray(c.eligible_surfaces)).toBe(true);
      expect(Array.isArray(c.forbidden_surfaces)).toBe(true);
      expect(
        c.expected_surface === null || typeof c.expected_surface === 'string',
      ).toBe(true);
    }
  });

  it.each(cases.map((c) => [c.test_case_id, c] as const))(
    '%s — validator outcome matches expected surface',
    (_id, c) => {
      const eligible: SurfaceDefinition[] = c.eligible_surfaces.map((key) => {
        const fromRegistry = SURFACE_REGISTRY.find((s) => s.key === key);
        return (
          fromRegistry ?? {
            key,
            kind: 'text' as const,
            description: key,
            isEligible: () => true,
          }
        );
      });

      const lastUser = [...c.history]
        .reverse()
        .find((m) => m.role === 'user')?.content ?? '';
      const result = validator.validate(
        c.mock_proposal,
        user,
        eligible,
        lastUser,
      );

      expect(result.ok).toBe(true);
      expect(result.surfaceKey ?? null).toBe(c.expected_surface);

      if (c.expected_action_type) {
        expect(result.actionType).toBe(c.expected_action_type);
      }

      if (c.expected_hints) {
        expect(result.extractedHints).toEqual(c.expected_hints);
      }

      if (c.expected_surface) {
        expect(c.forbidden_surfaces).not.toContain(c.expected_surface);
      }
      for (const forbidden of c.forbidden_surfaces) {
        expect(result.surfaceKey).not.toBe(forbidden);
      }
    },
  );
});
