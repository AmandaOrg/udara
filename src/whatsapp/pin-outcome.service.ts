import { Injectable } from "@nestjs/common";
import { BillPaymentStatus, TransactionStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PinFlowOutcome } from "./pin-gate.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { OnboardingService } from "../onboarding/onboarding.service";
import { NewDeviceCapService } from "../app-auth/new-device-cap.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { currentChannelContext } from "../messaging/channel-context";

/** What applying a PIN outcome did, for a caller that reports it itself. */
export type PinApplyResult =
  | { kind: "done" }
  | { kind: "capped"; cap: number; remaining: number; liftsAt: Date };

type CapCheck = { kind: "ok" } | Extract<PinApplyResult, { kind: "capped" }>;

/**
 * Acts on what PinGateService decided about a PIN submission. This is the only
 * place a verified PIN turns into money moving.
 *
 * It used to live inline in WhatsappRouterService. It is its own service so
 * that every channel that accepts a PIN (the WhatsApp Flow, the mobile app's
 * PIN screen) goes through the same few lines, rather than each channel
 * re-deciding what a verified PIN is allowed to trigger. For the same reason
 * the new-device cap is enforced here: it is the one door every payment
 * passes through after its PIN.
 */
@Injectable()
export class PinOutcomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly billPaymentConfirmation: BillPaymentConfirmationService,
    private readonly onboarding: OnboardingService,
    private readonly newDeviceCap: NewDeviceCapService,
    private readonly messenger: ChannelMessenger,
  ) {}

  /**
   * `quiet` skips the chat message when the new-device cap refuses the
   * payment, for the native route that returns the refusal instead.
   */
  async apply(
    outcome: PinFlowOutcome,
    userId: string,
    options: { quiet?: boolean } = {},
  ): Promise<PinApplyResult> {
    switch (outcome.action) {
      case "execute_transfer": {
        const check = await this.withinNewDeviceCap(
          userId,
          options,
          async () => {
            const row = await this.prisma.transaction.findFirst({
              where: { id: outcome.transactionId, userId },
              select: { amount: true },
            });
            return row ? Number(row.amount) : null;
          },
        );
        if (check.kind === "capped") {
          await this.prisma.transaction.updateMany({
            where: {
              id: outcome.transactionId,
              userId,
              status: TransactionStatus.PENDING_PIN,
            },
            data: { status: TransactionStatus.CANCELLED },
          });
          return check;
        }
        await this.transferConfirmation.executeVerifiedTransfer(
          outcome.transactionId,
        );
        return DONE;
      }
      case "execute_bill_payment": {
        const check = await this.withinNewDeviceCap(
          userId,
          options,
          async () => {
            const row = await this.prisma.billPayment.findFirst({
              where: { id: outcome.billPaymentId, userId },
              select: { amount: true },
            });
            return row ? Number(row.amount) : null;
          },
        );
        if (check.kind === "capped") {
          await this.prisma.billPayment.updateMany({
            where: {
              id: outcome.billPaymentId,
              userId,
              status: BillPaymentStatus.PENDING_PIN,
            },
            data: { status: BillPaymentStatus.CANCELLED },
          });
          return check;
        }
        await this.billPaymentConfirmation.executeVerifiedBillPayment(
          outcome.billPaymentId,
        );
        return DONE;
      }
      case "pin_setup_complete":
        // Whichever was waiting on the new PIN picks up where it left off.
        await this.transferConfirmation.resumeAfterPinSetup(userId);
        await this.billPaymentConfirmation.resumeAfterPinSetup(userId);
        await this.onboarding.resumeAfterPinSetup(userId);
        return DONE;
      case "none":
        return DONE;
    }
  }

  /**
   * Only a PIN entered in the app is capped: the device is what is new, and
   * only the app channel carries one, so WhatsApp skips this without even
   * reading the amount. A refusal is reported, and told to the user unless
   * the caller is quiet.
   */
  private async withinNewDeviceCap(
    userId: string,
    options: { quiet?: boolean },
    amountOf: () => Promise<number | null>,
  ): Promise<CapCheck> {
    const context = currentChannelContext();
    if (context?.channel !== "app") return { kind: "ok" };

    const amount = await amountOf();
    // Not this user's payment. The PIN challenge makes that unreachable, but
    // an unexplained id is not something to send money on.
    if (amount === null) {
      return { kind: "capped", cap: 0, remaining: 0, liftsAt: new Date() };
    }

    const verdict = context.deviceId
      ? await this.newDeviceCap.check(userId, context.deviceId, amount)
      : // An app event with no device is a wiring bug; refuse rather than guess.
        ({ ok: false, cap: 0, remaining: 0, liftsAt: new Date() } as const);
    if (verdict.ok) return { kind: "ok" };

    if (!options.quiet) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      await this.messenger.sendText(user, capMessage(verdict));
    }
    return {
      kind: "capped",
      cap: verdict.cap,
      remaining: verdict.remaining,
      liftsAt: verdict.liftsAt,
    };
  }
}

const DONE: PinApplyResult = { kind: "done" };

function capMessage(verdict: {
  cap: number;
  remaining: number;
  liftsAt: Date;
}): string {
  const hours = Math.max(
    1,
    Math.ceil((verdict.liftsAt.getTime() - Date.now()) / 3_600_000),
  );
  const lines = [
    `for your safety, a phone that signed in to udara in the last 24 hours can send up to ${naira(verdict.cap)} in total. this would go over that, so i've cancelled it and no money has moved.`,
    verdict.remaining > 0
      ? `you can send up to ${naira(verdict.remaining)} more from this phone right now, and the limit lifts in about ${hours} hour${hours === 1 ? "" : "s"}.`
      : `the limit lifts in about ${hours} hour${hours === 1 ? "" : "s"}.`,
  ];
  // No "or send it from WhatsApp": a swapped SIM can re-register WhatsApp
  // too, so that would be advice on getting around the cap.
  return lines.join("\n\n");
}

function naira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}
