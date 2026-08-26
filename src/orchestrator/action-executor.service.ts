/**
 * Executes a validated orchestrator turn: persona text first (wrapping),
 * then the deterministic UI surface / wizard fill / cancel.
 *
 * Lives under orchestrator/ but is provided by WhatsappModule because it
 * depends on WhatsApp send + account-action services.
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { AccountActionsService } from '../whatsapp/account-actions.service';
import { ChunkedMessengerService } from '../whatsapp/chunked-messenger.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { SpendSummaryService } from '../allowance/spend-summary.service';
import {
  OrchestratorResult,
  ORCHESTRATOR_FAILURE_MESSAGE,
} from './orchestrator.types';
import { TransferWizardHints } from './transfer-hints.util';

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);

  constructor(
    private readonly chunkedMessenger: ChunkedMessengerService,
    private readonly accountActions: AccountActionsService,
    private readonly spendSummary: SpendSummaryService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async execute(user: User, result: OrchestratorResult): Promise<void> {
    if (result.ok === false) {
      await this.sendSafeFallback(user);
      return;
    }

    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      result.message,
      user.id,
    );

    const actionType = result.actionType ?? 'reply_only';

    if (actionType === 'cancel_surface') {
      await this.accountActions.cancelActiveSurfaces(user);
      return;
    }

    if (actionType === 'fill_wizard') {
      await this.accountActions.applyHintsToDraft(
        user,
        result.extractedHints ?? {},
      );
      return;
    }

    if (actionType === 'show_surface' && result.surfaceKey) {
      // Topic change away from the transfer wizard must drop the draft so
      // the next turn isn't trapped in an abandoned send-money flow.
      if (result.surfaceKey !== 'transfer_wizard') {
        await this.accountActions.cancelActiveSurfaces(user);
      }
      await this.dispatchSurface(
        user,
        result.surfaceKey,
        result.extractedHints,
      );
    }
  }

  /** Short apology — do not dump the menu; that hijacks the user's next turn. */
  async sendSafeFallback(user: User): Promise<void> {
    await this.chunkedMessenger.sendChunkedReply(
      user.whatsappNumber,
      ORCHESTRATOR_FAILURE_MESSAGE,
      user.id,
    );
  }

  private async dispatchSurface(
    user: User,
    surfaceKey: string,
    hints?: TransferWizardHints,
  ): Promise<void> {
    switch (surfaceKey) {
      case 'balance_read':
        await this.accountActions.sendBalance(user);
        break;
      case 'limits_read':
        await this.accountActions.sendLimitsStatus(user);
        break;
      case 'account_details':
        await this.accountActions.sendAccountDetails(user);
        break;
      case 'transfer_wizard':
        // LLM owns extraction — do not re-parse session with regex recovery.
        await this.accountActions.startTransferWizard(user, hints, {
          recoverFromSession: false,
        });
        break;
      case 'spending_menu':
        await this.accountActions.sendMainMenu(user);
        break;
      case 'spend_summary': {
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
