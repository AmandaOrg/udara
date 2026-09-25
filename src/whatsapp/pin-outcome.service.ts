import { Injectable } from "@nestjs/common";
import { PinFlowOutcome } from "./pin-gate.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";

/**
 * Acts on what PinGateService decided about a PIN submission. This is the only
 * place a verified PIN turns into money moving.
 *
 * It used to live inline in WhatsappRouterService. It is its own service so
 * that every channel that accepts a PIN (the WhatsApp Flow today, the mobile
 * app's PIN screen next) goes through the same few lines, rather than each
 * channel re-deciding what a verified PIN is allowed to trigger.
 */
@Injectable()
export class PinOutcomeService {
  constructor(
    private readonly transferConfirmation: TransferConfirmationService,
    private readonly billPaymentConfirmation: BillPaymentConfirmationService,
  ) {}

  async apply(outcome: PinFlowOutcome, userId: string): Promise<void> {
    switch (outcome.action) {
      case "execute_transfer":
        await this.transferConfirmation.executeVerifiedTransfer(
          outcome.transactionId,
        );
        return;
      case "execute_bill_payment":
        await this.billPaymentConfirmation.executeVerifiedBillPayment(
          outcome.billPaymentId,
        );
        return;
      case "pin_setup_complete":
        // Whichever was waiting on the new PIN picks up where it left off.
        await this.transferConfirmation.resumeAfterPinSetup(userId);
        await this.billPaymentConfirmation.resumeAfterPinSetup(userId);
        return;
      case "none":
        return;
    }
  }
}
