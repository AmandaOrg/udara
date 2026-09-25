import { PinOutcomeService } from "./pin-outcome.service";

/**
 * The only place a verified PIN turns into money moving. Each outcome must
 * trigger exactly its own action and nothing else.
 */
describe("PinOutcomeService", () => {
  let transferConfirmation: {
    executeVerifiedTransfer: jest.Mock;
    resumeAfterPinSetup: jest.Mock;
  };
  let billPaymentConfirmation: {
    executeVerifiedBillPayment: jest.Mock;
    resumeAfterPinSetup: jest.Mock;
  };
  let service: PinOutcomeService;

  beforeEach(() => {
    transferConfirmation = {
      executeVerifiedTransfer: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    billPaymentConfirmation = {
      executeVerifiedBillPayment: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    service = new PinOutcomeService(
      transferConfirmation as any,
      billPaymentConfirmation as any,
    );
  });

  it("executes only the transfer the challenge was bound to", async () => {
    await service.apply(
      { action: "execute_transfer", transactionId: "txn-1" },
      "user-1",
    );

    expect(transferConfirmation.executeVerifiedTransfer).toHaveBeenCalledWith(
      "txn-1",
    );
    expect(
      billPaymentConfirmation.executeVerifiedBillPayment,
    ).not.toHaveBeenCalled();
  });

  it("executes only the bill payment the challenge was bound to", async () => {
    await service.apply(
      { action: "execute_bill_payment", billPaymentId: "bill-1" },
      "user-1",
    );

    expect(
      billPaymentConfirmation.executeVerifiedBillPayment,
    ).toHaveBeenCalledWith("bill-1");
    expect(transferConfirmation.executeVerifiedTransfer).not.toHaveBeenCalled();
  });

  it("resumes whatever was waiting once a first PIN is set, without executing anything", async () => {
    await service.apply({ action: "pin_setup_complete" }, "user-1");

    expect(transferConfirmation.resumeAfterPinSetup).toHaveBeenCalledWith(
      "user-1",
    );
    expect(billPaymentConfirmation.resumeAfterPinSetup).toHaveBeenCalledWith(
      "user-1",
    );
    expect(transferConfirmation.executeVerifiedTransfer).not.toHaveBeenCalled();
    expect(
      billPaymentConfirmation.executeVerifiedBillPayment,
    ).not.toHaveBeenCalled();
  });

  it("does nothing when the gate refused the submission", async () => {
    await service.apply({ action: "none" }, "user-1");

    expect(transferConfirmation.executeVerifiedTransfer).not.toHaveBeenCalled();
    expect(
      billPaymentConfirmation.executeVerifiedBillPayment,
    ).not.toHaveBeenCalled();
    expect(transferConfirmation.resumeAfterPinSetup).not.toHaveBeenCalled();
    expect(billPaymentConfirmation.resumeAfterPinSetup).not.toHaveBeenCalled();
  });
});
