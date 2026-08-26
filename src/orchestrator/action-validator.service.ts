/**
 * Validates every orchestrator proposal before execution. The guardrail
 * boundary — "the model proposes, code disposes."
 *
 * Validation rules:
 * 1. reply_only → text only, unless extracted_hints already name a send
 *    (amount + destination) — then launch transfer_wizard immediately
 * 2. show_surface → surface_key must exist and be eligible; high confidence
 *    unless transfer_wizard with actionable hints (do not stall on "go ahead")
 * 3. fill_wizard / cancel_surface → high confidence only; sanitize hints for fill
 * 4. Missing or medium confidence → downgrade to reply_only (safe default)
 * 5. Unknown surface key → downgrade to reply_only
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { ProposedTurn, OrchestratorResult } from './orchestrator.types';
import { SurfaceDefinition } from './surface-registry';
import {
  hasActionableTransferHints,
  sanitizeTransferHints,
  TransferWizardHints,
} from './transfer-hints.util';

@Injectable()
export class ActionValidatorService {
  private readonly logger = new Logger(ActionValidatorService.name);

  validate(
    proposal: ProposedTurn,
    user: User,
    eligibleSurfaces: SurfaceDefinition[],
  ): OrchestratorResult {
    const hints = sanitizeTransferHints(proposal.action.extracted_hints);
    const transferOk = this.transferWizardEligible(eligibleSurfaces);

    if (proposal.action.type === 'reply_only') {
      const promoted = this.promoteReadyTransfer(
        proposal.message,
        hints,
        transferOk,
        user.id,
        'reply_only',
      );
      if (promoted) return promoted;
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }

    const confidence = proposal.action.confidence ?? 'medium';
    if (confidence !== 'high') {
      const promoted = this.promoteReadyTransfer(
        proposal.message,
        hints,
        transferOk,
        user.id,
        `${proposal.action.type}:${confidence}`,
      );
      if (promoted) return promoted;
      this.logger.debug(
        `${confidence} confidence on "${proposal.action.type}" for user ${user.id} — sending text only`,
      );
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }

    if (proposal.action.type === 'cancel_surface') {
      return {
        message: proposal.message,
        actionType: 'cancel_surface',
        ok: true,
      };
    }

    if (proposal.action.type === 'fill_wizard') {
      return {
        message: proposal.message,
        actionType: 'fill_wizard',
        extractedHints: hints,
        ok: true,
      };
    }

    // show_surface
    const surfaceKey = proposal.action.surface_key;
    if (!surfaceKey) {
      const promoted = this.promoteReadyTransfer(
        proposal.message,
        hints,
        transferOk,
        user.id,
        'show_surface:no_key',
      );
      if (promoted) return promoted;
      this.logger.warn(
        `show_surface proposed with no surface_key for user ${user.id} — downgrading to reply_only`,
      );
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }

    const surface = eligibleSurfaces.find((s) => s.key === surfaceKey);
    if (!surface) {
      this.logger.warn(
        `Surface "${surfaceKey}" not eligible for user ${user.id} — downgrading to reply_only`,
      );
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }

    const extractedHints =
      surfaceKey === 'transfer_wizard' ? hints : undefined;

    return {
      message: proposal.message,
      actionType: 'show_surface',
      surfaceKey,
      extractedHints,
      ok: true,
    };
  }

  private transferWizardEligible(
    eligibleSurfaces: SurfaceDefinition[],
  ): boolean {
    return eligibleSurfaces.some((s) => s.key === 'transfer_wizard');
  }

  private promoteReadyTransfer(
    message: string,
    hints: TransferWizardHints,
    transferOk: boolean,
    userId: string,
    from: string,
  ): OrchestratorResult | null {
    if (!transferOk || !hasActionableTransferHints(hints)) return null;
    this.logger.debug(
      `Promoting ${from} to transfer_wizard for user ${userId} — actionable hints present`,
    );
    return {
      message,
      actionType: 'show_surface',
      surfaceKey: 'transfer_wizard',
      extractedHints: hints,
      ok: true,
    };
  }
}
