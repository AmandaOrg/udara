/**
 * Validates every orchestrator proposal before execution. The guardrail
 * boundary — "the model proposes, code disposes."
 *
 * Validation rules:
 * 1. reply_only → text only, unless this is an active send that already
 *    states a purpose (or a spend-check is in progress) and hints name a send
 * 2. Vague first sends pause for a spend check (no transfer_wizard)
 * 3. show_surface → surface_key must exist and be eligible; high confidence
 * 4. fill_wizard / cancel_surface → high confidence only; sanitize hints for fill
 * 5. Missing or medium confidence → downgrade to reply_only (safe default)
 * 6. Unknown surface key → downgrade to reply_only
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { ProposedTurn, OrchestratorResult } from './orchestrator.types';
import { SurfaceDefinition } from './surface-registry';
import {
  hasActionableTransferHints,
  isActiveSendUtterance,
  isClosedTransferUtterance,
  isSpendCheckAbortUtterance,
  isSpendCheckProceedUtterance,
  sanitizeTransferHints,
  shouldPauseForSpendCheck,
  TransferWizardHints,
} from './transfer-hints.util';

export type ActionValidatorOptions = {
  spendCheckPending?: boolean;
};

@Injectable()
export class ActionValidatorService {
  private readonly logger = new Logger(ActionValidatorService.name);

  validate(
    proposal: ProposedTurn,
    user: User,
    eligibleSurfaces: SurfaceDefinition[],
    userText = '',
    options: ActionValidatorOptions = {},
  ): OrchestratorResult {
    const hints = sanitizeTransferHints(proposal.action.extracted_hints);
    const transferOk = this.transferWizardEligible(eligibleSurfaces);
    const sendingNow = isActiveSendUtterance(userText);
    const closedSend = isClosedTransferUtterance(userText);
    const aborting = isSpendCheckAbortUtterance(userText);
    const pause = !options.spendCheckPending && shouldPauseForSpendCheck(
      userText,
      hints,
    );
    const mayPromote =
      transferOk &&
      hasActionableTransferHints(hints) &&
      !closedSend &&
      !aborting &&
      !pause &&
      (sendingNow ||
        (options.spendCheckPending && isSpendCheckProceedUtterance(userText)));

    if (proposal.action.type === 'reply_only') {
      if (mayPromote) {
        return this.promoteReadyTransfer(
          proposal.message,
          hints,
          user.id,
          'reply_only',
        );
      }
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }

    const confidence = proposal.action.confidence ?? 'medium';
    if (confidence !== 'high') {
      if (mayPromote) {
        return this.promoteReadyTransfer(
          proposal.message,
          hints,
          user.id,
          `${proposal.action.type}:${confidence}`,
        );
      }
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
      if (closedSend) {
        this.logger.debug(
          `Blocking fill_wizard for user ${user.id} — utterance closed the send`,
        );
        return {
          message: proposal.message,
          actionType: 'reply_only',
          ok: true,
        };
      }
      return {
        message: proposal.message,
        actionType: 'fill_wizard',
        extractedHints: hints,
        ok: true,
      };
    }

    // show_surface
    const surfaceKey = proposal.action.surface_key;
    if (
      surfaceKey === 'transfer_wizard' &&
      (closedSend || aborting || pause)
    ) {
      this.logger.debug(
        `Blocking transfer_wizard for user ${user.id} — ${pause ? 'spend check' : 'closed or aborted send'}`,
      );
      return {
        message: proposal.message,
        actionType: 'reply_only',
        ok: true,
      };
    }
    if (!surfaceKey) {
      if (mayPromote) {
        return this.promoteReadyTransfer(
          proposal.message,
          hints,
          user.id,
          'show_surface:no_key',
        );
      }
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
    userId: string,
    from: string,
  ): OrchestratorResult {
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
