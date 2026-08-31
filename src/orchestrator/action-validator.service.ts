/**
 * Validates every orchestrator proposal before execution. The guardrail
 * boundary — "the model proposes, code disposes."
 *
 * Validation rules:
 * 1. reply_only → text only, unless a spend-check is in progress and they
 *    proceed and hints name a send or bill
 * 2. First active sends / bill purchases pause (no wizard)
 * 3. show_surface → surface_key must exist and be eligible; high confidence
 * 4. fill_wizard / cancel_surface → high confidence only; sanitize hints for fill
 * 5. Missing or medium confidence → downgrade to reply_only (safe default)
 * 6. Unknown surface key → downgrade to reply_only
 * 7. Bill-shaped utterances never promote onto transfer_wizard
 */

import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { ProposedTurn, OrchestratorResult } from "./orchestrator.types";
import { SurfaceDefinition } from "./surface-registry";
import {
  inferBillSurfaceFromText,
  isBillPaymentSurface,
  isBillPaymentUtterance,
  moneyOutWizardSurface,
} from "./bill-hints.util";
import {
  hasActionableTransferHints,
  isActiveSendUtterance,
  isClosedTransferUtterance,
  isSpendCheckAbortUtterance,
  isSpendCheckProceedUtterance,
  sanitizeTransferHints,
  shouldPauseForSpendCheck,
  TransferWizardHints,
} from "./transfer-hints.util";

export type ActionValidatorOptions = {
  spendCheckPending?: boolean;
  pendingSurface?: string;
};

@Injectable()
export class ActionValidatorService {
  private readonly logger = new Logger(ActionValidatorService.name);

  validate(
    proposal: ProposedTurn,
    user: User,
    eligibleSurfaces: SurfaceDefinition[],
    userText = "",
    options: ActionValidatorOptions = {},
  ): OrchestratorResult {
    const hints = sanitizeTransferHints(proposal.action.extracted_hints);
    const transferOk = this.surfaceEligible(
      eligibleSurfaces,
      "transfer_wizard",
    );
    const sendingNow = isActiveSendUtterance(userText);
    const billNow = isBillPaymentUtterance(userText);
    const closedSend = isClosedTransferUtterance(userText);
    const aborting = isSpendCheckAbortUtterance(userText);
    const pause =
      !options.spendCheckPending && shouldPauseForSpendCheck(userText);

    const proceed =
      options.spendCheckPending && isSpendCheckProceedUtterance(userText);
    const resumeSurface = this.resumeSurface(
      userText,
      proposal.action.surface_key,
      options.pendingSurface,
    );

    const mayPromoteTransfer =
      transferOk &&
      hasActionableTransferHints(hints) &&
      !closedSend &&
      !aborting &&
      !pause &&
      !billNow &&
      !isBillPaymentSurface(resumeSurface) &&
      (sendingNow || proceed);

    const mayPromoteBill =
      isBillPaymentSurface(resumeSurface) &&
      this.surfaceEligible(eligibleSurfaces, resumeSurface) &&
      !closedSend &&
      !aborting &&
      !pause &&
      proceed;

    if (proposal.action.type === "reply_only") {
      if (mayPromoteBill && resumeSurface) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          resumeSurface,
          user.id,
          "reply_only",
        );
      }
      if (mayPromoteTransfer) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          "transfer_wizard",
          user.id,
          "reply_only",
        );
      }
      return {
        message: proposal.message,
        actionType: "reply_only",
        ok: true,
      };
    }

    const confidence = proposal.action.confidence ?? "medium";
    if (confidence !== "high") {
      if (mayPromoteBill && resumeSurface) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          resumeSurface,
          user.id,
          `${proposal.action.type}:${confidence}`,
        );
      }
      if (mayPromoteTransfer) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          "transfer_wizard",
          user.id,
          `${proposal.action.type}:${confidence}`,
        );
      }
      this.logger.debug(
        `${confidence} confidence on "${proposal.action.type}" for user ${user.id} — sending text only`,
      );
      return {
        message: proposal.message,
        actionType: "reply_only",
        ok: true,
      };
    }

    if (proposal.action.type === "cancel_surface") {
      return {
        message: proposal.message,
        actionType: "cancel_surface",
        ok: true,
      };
    }

    if (proposal.action.type === "fill_wizard") {
      if (closedSend) {
        this.logger.debug(
          `Blocking fill_wizard for user ${user.id} — utterance closed the send`,
        );
        return {
          message: proposal.message,
          actionType: "reply_only",
          ok: true,
        };
      }
      return {
        message: proposal.message,
        actionType: "fill_wizard",
        extractedHints: hints,
        ok: true,
      };
    }

    // show_surface
    let surfaceKey = proposal.action.surface_key;
    if (
      surfaceKey === "transfer_wizard" &&
      (billNow || isBillPaymentSurface(resumeSurface))
    ) {
      surfaceKey =
        resumeSurface ?? inferBillSurfaceFromText(userText) ?? undefined;
    }

    if (
      moneyOutWizardSurface(surfaceKey) &&
      (closedSend || aborting || pause)
    ) {
      this.logger.debug(
        `Blocking ${surfaceKey} for user ${user.id} — ${pause ? "spend check" : "closed or aborted send"}`,
      );
      return {
        message: proposal.message,
        actionType: "reply_only",
        ok: true,
      };
    }
    if (!surfaceKey) {
      if (mayPromoteBill && resumeSurface) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          resumeSurface,
          user.id,
          "show_surface:no_key",
        );
      }
      if (mayPromoteTransfer) {
        return this.promoteReadySurface(
          proposal.message,
          hints,
          "transfer_wizard",
          user.id,
          "show_surface:no_key",
        );
      }
      this.logger.warn(
        `show_surface proposed with no surface_key for user ${user.id} — downgrading to reply_only`,
      );
      return {
        message: proposal.message,
        actionType: "reply_only",
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
        actionType: "reply_only",
        ok: true,
      };
    }

    const keepHints =
      surfaceKey === "transfer_wizard" || isBillPaymentSurface(surfaceKey);

    return {
      message: proposal.message,
      actionType: "show_surface",
      surfaceKey,
      extractedHints: keepHints ? hints : undefined,
      ok: true,
    };
  }

  private resumeSurface(
    userText: string,
    proposedKey: string | undefined,
    pendingSurface?: string,
  ): string | undefined {
    if (isBillPaymentSurface(proposedKey)) return proposedKey;
    const fromText = inferBillSurfaceFromText(userText);
    if (fromText) return fromText;
    if (isBillPaymentSurface(pendingSurface)) return pendingSurface;
    return pendingSurface === "transfer_wizard" ? "transfer_wizard" : undefined;
  }

  private surfaceEligible(
    eligibleSurfaces: SurfaceDefinition[],
    key: string,
  ): boolean {
    return eligibleSurfaces.some((s) => s.key === key);
  }

  private promoteReadySurface(
    message: string,
    hints: TransferWizardHints,
    surfaceKey: string,
    userId: string,
    from: string,
  ): OrchestratorResult {
    this.logger.debug(
      `Promoting ${from} to ${surfaceKey} for user ${userId} — actionable hints present`,
    );
    return {
      message,
      actionType: "show_surface",
      surfaceKey,
      extractedHints: hints,
      ok: true,
    };
  }
}
