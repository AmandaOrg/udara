import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { RubiesSignatureGuard } from "./rubies-signature.guard";
import { mapRubiesResponseCode } from "./rubies.service";
import {
  OnboardingStage,
  Prisma,
  RubiesWebhookEventType,
  TransactionStatus,
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
@Controller("webhooks/rubies")
export class RubiesWebhookController {
  private readonly logger = new Logger(RubiesWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allowance: AllowanceService,
    private readonly whatsapp: WhatsappService,
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
   * PRD §3 #4a — "when Kedu receives funds into the account, it sends a
   * WhatsApp message confirming receipt." A v0 must-have on its own, distinct
   * from and simpler than the deferred proactive-nudge feature (§13/Phase 9)
   * — this send is unconditional, not gated behind any nudge/dedup logic.
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

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `We've received ₦${amount.toLocaleString("en-NG")} into your Kedu account. It'll be available during your next spending window.`,
      user.id,
    );

    if (user.onboardingStage === OnboardingStage.ACCOUNT_CREATED) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { onboardingStage: OnboardingStage.FUNDED },
      });
    }
  }

  /**
   * The async confirmation path for a transfer that came back PENDING from
   * initiateTransfer — updates Transaction.status from the response code
   * (same 00/09·90·99/other mapping RubiesService uses) and only then calls
   * AllowanceService.recordSpend, which is itself idempotent so a duplicate
   * webhook delivery or overlap with the TSQ reconciliation job (Phase 8) is
   * always safe.
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

    const newStatus =
      status === "SUCCESS"
        ? TransactionStatus.EXECUTED
        : TransactionStatus.FAILED;
    if (transaction.status === newStatus) return; // already applied, avoid redundant work

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: newStatus,
        rubiesReference: payload.paymentReference,
        executedAt:
          newStatus === TransactionStatus.EXECUTED ? new Date() : undefined,
      },
    });

    if (newStatus === TransactionStatus.EXECUTED) {
      await this.allowance.recordSpend(transaction.id);
    }
  }
}
