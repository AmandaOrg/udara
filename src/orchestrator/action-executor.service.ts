/**
 * Executes a validated orchestrator turn: persona text first (wrapping),
 * then the deterministic UI surface / wizard fill / cancel.
 *
 * Lives under orchestrator/ but is provided by WhatsappModule because it
 * depends on WhatsApp send + account-action services.
 */

import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { AccountActionsService } from "../whatsapp/account-actions.service";
import { BillPaymentActionsService } from "../whatsapp/bill-payment-actions.service";
import { ChunkedMessengerService } from "../whatsapp/chunked-messenger.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { PinGateService } from "../whatsapp/pin-gate.service";
import { SpendSummaryService } from "../allowance/spend-summary.service";
import { OrchestratorResult } from "./orchestrator.types";
import { TransferWizardHints } from "./transfer-hints.util";
import { SettingsChangeType } from "@prisma/client";
import { ManagerConversationService } from "../manager/manager-conversation.service";
import { sanitizeSurfaceLeadIn } from "./sanitize-lead-in.util";

import { isBillPaymentSurface } from "./bill-hints.util";

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);

  constructor(
    private readonly chunkedMessenger: ChunkedMessengerService,
    private readonly accountActions: AccountActionsService,
    private readonly billPaymentActions: BillPaymentActionsService,
    private readonly spendSummary: SpendSummaryService,
    private readonly whatsapp: WhatsappService,
    private readonly pinGate: PinGateService,
    private readonly managerConversation: ManagerConversationService,
  ) {}

  async execute(user: User, result: OrchestratorResult): Promise<void> {
    if (result.ok === false) {
      await this.sendQuietFallback(user);
      return;
    }

    const actionType = result.actionType ?? "reply_only";
    const launchingSurface =
      actionType === "show_surface" && !!result.surfaceKey;

    const leadIn = launchingSurface
      ? sanitizeSurfaceLeadIn(result.message, result.surfaceKey)
      : result.message;

    if (leadIn) {
      if (launchingSurface) {
        await this.whatsapp.sendText(user.whatsappNumber, leadIn, user.id);
      } else {
        await this.chunkedMessenger.sendChunkedReply(
          user.whatsappNumber,
          leadIn,
          user.id,
        );
      }
    }

    if (actionType === "cancel_surface") {
      await this.accountActions.cancelActiveSurfaces(user);
      return;
    }

    if (actionType === "fill_wizard") {
      const billDraft = await this.billPaymentActions.getActiveDraft(user.id);
      if (billDraft) {
        await this.billPaymentActions.applyHintsToDraft(
          user,
          result.extractedHints ?? {},
        );
        return;
      }
      await this.accountActions.applyHintsToDraft(
        user,
        result.extractedHints ?? {},
      );
      return;
    }

    if (actionType === "show_surface" && result.surfaceKey) {
      // Topic change away from the transfer wizard must drop the draft so
      // the next turn isn't trapped in an abandoned send-money flow.
      if (
        result.surfaceKey !== "transfer_wizard" &&
        !isBillPaymentSurface(result.surfaceKey)
      ) {
        await this.accountActions.cancelActiveSurfaces(user);
      }
      await this.dispatchSurface(
        user,
        result.surfaceKey,
        result.extractedHints,
      );
    }
  }

  /**
   * LLM failed in the background — don't tell the user we "missed" them.
   * Offer the menu so the next tap is deterministic.
   */
  async sendQuietFallback(user: User): Promise<void> {
    this.logger.warn(
      `Orchestrator fallback for user ${user.id} — showing menu without miss copy`,
    );
    await this.accountActions.sendMainMenu(user);
  }

  /** @deprecated use sendQuietFallback */
  async sendSafeFallback(user: User): Promise<void> {
    await this.sendQuietFallback(user);
  }

  private async dispatchSurface(
    user: User,
    surfaceKey: string,
    hints?: TransferWizardHints,
  ): Promise<void> {
    switch (surfaceKey) {
      case "balance_read":
        await this.accountActions.sendBalance(user);
        break;
      case "limits_read":
        await this.accountActions.sendLimitsStatus(user);
        break;
      case "account_details":
        await this.accountActions.sendAccountDetails(user);
        break;
      case "transfer_wizard": {
        const resumed = await this.accountActions.resumePendingTransfer(user);
        if (resumed) break;
        await this.accountActions.startTransferWizard(user, hints, {
          recoverFromSession: false,
        });
        break;
      }
      case "bill_payment_wizard":
        await this.billPaymentActions.startAirtimeWizard(user, hints);
        break;
      case "data_bundle_wizard":
        await this.billPaymentActions.startDataWizard(user, hints);
        break;
      case "electricity_wizard":
        await this.billPaymentActions.startElectricityWizard(user, hints);
        break;
      case "spending_menu":
        await this.accountActions.sendMainMenu(user);
        break;
      case "pin_reset":
        await this.pinGate.requestPinReset(user);
        break;
      case "settings_request":
        // Files the request and nothing else. See ADR-0001: the model cannot
        // change a setting, cannot influence eligibleAt, and cannot lift
        // restrictions — all three still live behind ManagerService.
        await this.managerConversation.fileChangeRequest({
          userId: user.id,
          type: hints?.settingsChangeType ?? SettingsChangeType.OTHER,
          requestedChange: hints?.settingsReason ?? "unspecified change",
          reason: hints?.settingsReason,
        });
        break;
      case "spend_summary": {
        const summary = await this.spendSummary.getWeeklySummary(user.id);
        await this.whatsapp.sendText(
          user.whatsappNumber,
          this.spendSummary.formatAsText(summary),
          user.id,
        );
        break;
      }
      default:
        this.logger.warn(
          `Unknown surface key "${surfaceKey}" from orchestrator — skipping`,
        );
    }
  }
}
