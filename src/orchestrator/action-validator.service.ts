/**
 * Validates every orchestrator proposal before execution. The guardrail
 * boundary — "the model proposes, code disposes."
 *
 * Validation rules:
 * 1. reply_only → always passes (just text, no side effects)
 * 2. show_surface → surface_key must exist and be eligible
 * 3. Missing or medium confidence → downgrade to reply_only (safe default)
 * 4. Only confidence === "high" launches a surface
 * 5. Unknown surface key → downgrade to reply_only
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { ProposedTurn, OrchestratorResult } from './orchestrator.types';
import { SurfaceDefinition } from './surface-registry';

@Injectable()
export class ActionValidatorService {
  private readonly logger = new Logger(ActionValidatorService.name);

  validate(
    proposal: ProposedTurn,
    user: User,
    eligibleSurfaces: SurfaceDefinition[],
  ): OrchestratorResult {
    // reply_only is always safe — just persona text, no side effects.
    if (proposal.action.type === 'reply_only') {
      return { message: proposal.message, ok: true };
    }

    const surfaceKey = proposal.action.surface_key;

    // show_surface without a key is malformed — downgrade.
    if (!surfaceKey) {
      this.logger.warn(
        `show_surface proposed with no surface_key for user ${user.id} — downgrading to reply_only`,
      );
      return {
        message: proposal.message,
        ok: true,
      };
    }

    // Surface must be in the eligible set (double-check — the model should
    // only see eligible surfaces, but it can hallucinate).
    const surface = eligibleSurfaces.find((s) => s.key === surfaceKey);
    if (!surface) {
      this.logger.warn(
        `Surface "${surfaceKey}" not eligible for user ${user.id} — downgrading to reply_only`,
      );
      return {
        message: proposal.message,
        ok: true,
      };
    }

    // Missing confidence = medium. Only explicit "high" launches a surface.
    const confidence = proposal.action.confidence ?? 'medium';
    if (confidence !== 'high') {
      this.logger.debug(
        `${confidence} confidence on "${surfaceKey}" for user ${user.id} — sending text only`,
      );
      return {
        message: proposal.message,
        ok: true,
      };
    }

    // All checks passed — execute the surface.
    return {
      message: proposal.message,
      surfaceKey,
      extractedHints: proposal.action.extracted_hints,
      ok: true,
    };
  }
}
