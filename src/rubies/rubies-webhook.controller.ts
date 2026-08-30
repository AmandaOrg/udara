import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { TransferConfirmationService } from "../whatsapp/transfer-confirmation.service";
import { AllowanceService } from "../allowance/allowance.service";
import { EmailNotificationsService } from "../email/email-notifications.service";
import { displayFirstNameOrThere } from "../common/display-name.util";
import { RubiesSignatureGuard } from "./rubies-signature.guard";
import { mapRubiesResponseCode } from "./rubies.service";
import {
  OnboardingStage,
  Prisma,
  RubiesWebhookEventType,
} from "@prisma/client";

/**
 * Rubies' unified transaction-notification payload — one shape covers both
 * directions (drCr: "CR" = money in, "DR" = money out), matching the
 * NotificationRequest schema confirmed against the live RubiesSme API docs.
 */
interface RubiesNotification {
  amount?: string;
  originatorAccountNumber?: string;
  originatorName?: string;
  creditAccount?: string;
  creditAccountName?: string;
  bankName?: string;
  bankCode?: string;
  narration?: string;
  paymentReference?: string;
  sessionId?: string;
  service?: string;
  drCr?: "CR" | "DR" | string;
  responseCode?: string;
  responseMessage?: string;
}

/**
 * Inbound Rubies webhook — entirely absent before this phase. The callback
 * URL itself is registered as `apiKeyLiveCallback` in the Rubies dashboard
 * (an external manual step, not something this code does — same category as
 * Meta's template approval, Phase 9).
 */
@Controller("rubies/webhooks")
export class RubiesWebhookController {
  private readonly logger = new Logger(RubiesWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly allowance: AllowanceService,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  @UseGuards(RubiesSignatureGuard)
  @Post()
  async receive(@Body() payload: RubiesNotification) {
    const eventType =
      payload.drCr === "CR"
        ? RubiesWebhookEventType.INCOMING_CREDIT
        : payload.drCr === "DR"
          ? RubiesWebhookEventType.TRANSFER_STATUS
          : RubiesWebhookEventType.UNKNOWN;

    await this.prisma.rubiesWebhookEvent.create({
      data: {
        eventType,
        rubiesReference: payload.paymentReference,
        rawPayload: payload as unknown as Prisma.InputJsonValue,
        signatureValid: true, // the guard above already enforced this before we got here
        processedAt: new Date(),
      },
    });

    try {
      if (eventType === RubiesWebhookEventType.INCOMING_CREDIT) {
        await this.handleIncomingCredit(payload);
      } else if (eventType === RubiesWebhookEventType.TRANSFER_STATUS) {
        await this.handleTransferStatus(payload);
      } else {
        this.logger.warn(
          `Unrecognized Rubies webhook event (no drCr): ${JSON.stringify(payload)}`,
        );
      }
    } catch (err) {
      // Never let a processing error surface as a non-200 back to Rubies — that would
      // just trigger redelivery of a payload we've already durably logged above.
      this.logger.error(`Failed to process Rubies webhook: ${String(err)}`);
    }

    return { responseCode: "00", responseMessage: "Received" };
  }

  /**
   * PRD §3 #4a — "when Udara receives funds into the account, it sends a
   * WhatsApp message confirming receipt." A v0 must-have on its own, distinct
   * from and simpler than the deferred proactive-nudge feature (§13/Phase 9)
   * — this send is unconditional, not gated behind any nudge/dedup logic.
   *
   * When this credit is the one that completes onboarding (user was sitting
   * at ACCOUNT_CREATED, i.e. plan built, awaiting first funding — Udara
   * script Stage 9/10), the message is the celebratory activation copy with
   * the actual daily/weekly figures instead of the generic notice.
   */
  private async handleIncomingCredit(
    payload: RubiesNotification,
  ): Promise<void> {
    if (!payload.creditAccount || !payload.paymentReference) return;

    const user = await this.prisma.user.findUnique({
      where: { rubiesAccountNumber: payload.creditAccount },
    });
    if (!user) {
      this.logger.warn(
        `Incoming credit to unrecognized account ${payload.creditAccount}`,
      );
      return;
    }

    const existing = await this.prisma.incomingCredit.findUnique({
      where: { rubiesReference: payload.paymentReference },
    });
    if (existing) return; // dedup — Rubies may redeliver the same notification

    const amount = Number(payload.amount ?? 0);

    await this.prisma.incomingCredit.create({
      data: {
        userId: user.id,
        amount,
        rubiesReference: payload.paymentReference,
        sourceNarration: payload.narration,
        creditedAt: new Date(),
      },
    });

    // Best-effort, keyed on the Rubies reference so a redelivered webhook
    // can't double-send. Never awaited for its result beyond completion:
    // EmailNotificationsService swallows its own failures.
    await this.emailNotifications.sendMoneyIn({
      user,
      amount,
      rubiesReference: payload.paymentReference,
      senderName: payload.originatorName ?? null,
    });

    const completesOnboarding =
      user.onboardingStage === OnboardingStage.ACCOUNT_CREATED;

    if (completesOnboarding) {
      const dailyAllowance = await this.allowance.getOrCreateTodayAllowance(
        user.id,
      );
      const daily = Number(dailyAllowance.amountAllocated);
      const weekly = daily * 7;
      const firstName = displayFirstNameOrThere(user.name);
      const message = [
        `₦${amount.toLocaleString("en-NG")} received, ${firstName} 🎉 your udara account is now active.`,
        `daily spending limit: ₦${daily.toLocaleString("en-NG")}\nweekly spending limit: ₦${weekly.toLocaleString("en-NG")}`,
        "spending window opens 11am, closes 8pm. i'll check in with you as you go, let's get started.",
      ].join("\n\n");
      await this.whatsapp.sendText(user.whatsappNumber, message, user.id);

      await this.prisma.user.update({
        where: { id: user.id },
        data: { onboardingStage: OnboardingStage.FUNDED },
      });
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `We've received ₦${amount.toLocaleString("en-NG")} into your Udara account. It'll be available during your next spending window.`,
      user.id,
    );
  }

  /**
   * The async confirmation path for a transfer that came back PENDING from
   * initiateTransfer — resolves the final status (same 00/09·90·99/other
   * mapping RubiesService uses) and delegates to
   * TransferConfirmationService.applyTransferResult, the same method the
   * TSQ reconciliation scheduler calls for the same scenario. That method
   * is itself idempotent (a no-op once the transaction is already
   * EXECUTED/FAILED) and is also what creates OverrideHistory, sweeps any
   * override fee to the fees account, and sends the user's confirmation
   * message — this path used to reimplement a partial version of that logic
   * inline, which meant a transfer resolved via webhook (rather than the
   * synchronous confirm-button path or the reconciliation scheduler) never
   * got any of those. Sharing one method fixes that instead of adding a
   * fourth copy.
   */
  private async handleTransferStatus(
    payload: RubiesNotification,
  ): Promise<void> {
    if (!payload.paymentReference) return;

    const transaction = await this.prisma.transaction.findUnique({
      where: { idempotencyKey: payload.paymentReference },
    });
    if (!transaction) {
      this.logger.warn(
        `Transfer-status callback for unrecognized reference ${payload.paymentReference}`,
      );
      return;
    }

    const status = mapRubiesResponseCode(payload.responseCode);
    if (status === "PENDING") return; // nothing to do yet — wait for a final callback or TSQ reconciliation

    await this.transferConfirmation.applyTransferResult(
      transaction.id,
      status,
      payload.paymentReference,
    );
  }
}
