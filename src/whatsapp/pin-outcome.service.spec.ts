import { PinOutcomeService } from "./pin-outcome.service";
import { runInChannel } from "../messaging/channel-context";

/**
 * The only place a verified PIN turns into money moving. Each outcome must
 * trigger exactly its own action and nothing else, and a PIN entered on a
 * newly signed-in phone must stay inside that phone's first-day cap.
 */
describe("PinOutcomeService", () => {
  let prisma: {
    transaction: { findFirst: jest.Mock; updateMany: jest.Mock };
    billPayment: { findFirst: jest.Mock; updateMany: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock };
  };
  let transferConfirmation: {
    executeVerifiedTransfer: jest.Mock;
    resumeAfterPinSetup: jest.Mock;
  };
  let billPaymentConfirmation: {
    executeVerifiedBillPayment: jest.Mock;
    resumeAfterPinSetup: jest.Mock;
  };
  let onboarding: { resumeAfterPinSetup: jest.Mock };
  let newDeviceCap: { check: jest.Mock };
  let messenger: { sendText: jest.Mock };
  let service: PinOutcomeService;

  const inApp = <T>(fn: () => Promise<T>) =>
    runInChannel({ channel: "app", deviceId: "device-1" }, fn);

  beforeEach(() => {
    prisma = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue({ amount: 15_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      billPayment: {
        findFirst: jest.fn().mockResolvedValue({ amount: 2_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "user-1", whatsappNumber: null }),
      },
    };
    transferConfirmation = {
      executeVerifiedTransfer: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    billPaymentConfirmation = {
      executeVerifiedBillPayment: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    onboarding = {
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    newDeviceCap = { check: jest.fn().mockResolvedValue({ ok: true }) };
    messenger = { sendText: jest.fn().mockResolvedValue(undefined) };
    service = new PinOutcomeService(
      prisma as any,
      transferConfirmation as any,
      billPaymentConfirmation as any,
      onboarding as any,
      newDeviceCap as any,
      messenger as any,
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
    expect(onboarding.resumeAfterPinSetup).toHaveBeenCalledWith("user-1");
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
    expect(onboarding.resumeAfterPinSetup).not.toHaveBeenCalled();
  });

  describe("new-device cap", () => {
    it("never applies to a PIN entered on WhatsApp, and costs no extra query there", async () => {
      await runInChannel({ channel: "whatsapp" }, () =>
        service.apply(
          { action: "execute_transfer", transactionId: "txn-1" },
          "user-1",
        ),
      );

      expect(newDeviceCap.check).not.toHaveBeenCalled();
      expect(prisma.transaction.findFirst).not.toHaveBeenCalled();
      expect(transferConfirmation.executeVerifiedTransfer).toHaveBeenCalled();
    });

    it("checks an app PIN against the device it came from, with the payment's own amount", async () => {
      await inApp(() =>
        service.apply(
          { action: "execute_transfer", transactionId: "txn-1" },
          "user-1",
        ),
      );

      expect(prisma.transaction.findFirst).toHaveBeenCalledWith({
        where: { id: "txn-1", userId: "user-1" },
        select: { amount: true },
      });
      expect(newDeviceCap.check).toHaveBeenCalledWith(
        "user-1",
        "device-1",
        15_000,
      );
      expect(transferConfirmation.executeVerifiedTransfer).toHaveBeenCalledWith(
        "txn-1",
      );
    });

    it("cancels a transfer over the cap before any money moves, and says why", async () => {
      newDeviceCap.check.mockResolvedValue({
        ok: false,
        cap: 20_000,
        remaining: 5_000,
        liftsAt: new Date(Date.now() + 3 * 3_600_000),
      });

      await inApp(() =>
        service.apply(
          { action: "execute_transfer", transactionId: "txn-1" },
          "user-1",
        ),
      );

      expect(
        transferConfirmation.executeVerifiedTransfer,
      ).not.toHaveBeenCalled();
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", userId: "user-1", status: "PENDING_PIN" },
        data: { status: "CANCELLED" },
      });
      const text = messenger.sendText.mock.calls[0][1] as string;
      expect(text).toContain("₦20,000");
      expect(text).toContain("₦5,000 more");
      expect(text).toContain("about 3 hours");
      expect(text).not.toMatch(/whatsapp/i);
    });

    it("caps bill payments the same way", async () => {
      newDeviceCap.check.mockResolvedValue({
        ok: false,
        cap: 20_000,
        remaining: 0,
        liftsAt: new Date(Date.now() + 3_600_000),
      });

      await inApp(() =>
        service.apply(
          { action: "execute_bill_payment", billPaymentId: "bill-1" },
          "user-1",
        ),
      );

      expect(newDeviceCap.check).toHaveBeenCalledWith(
        "user-1",
        "device-1",
        2_000,
      );
      expect(
        billPaymentConfirmation.executeVerifiedBillPayment,
      ).not.toHaveBeenCalled();
      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", userId: "user-1", status: "PENDING_PIN" },
        data: { status: "CANCELLED" },
      });
    });

    it("refuses an app PIN that names a payment not belonging to the user", async () => {
      prisma.transaction.findFirst.mockResolvedValue(null);

      await inApp(() =>
        service.apply(
          { action: "execute_transfer", transactionId: "txn-other" },
          "user-1",
        ),
      );

      expect(
        transferConfirmation.executeVerifiedTransfer,
      ).not.toHaveBeenCalled();
      expect(newDeviceCap.check).not.toHaveBeenCalled();
    });

    it("refuses an app PIN with no device in context rather than skipping the cap", async () => {
      await runInChannel({ channel: "app" }, () =>
        service.apply(
          { action: "execute_transfer", transactionId: "txn-1" },
          "user-1",
        ),
      );

      expect(
        transferConfirmation.executeVerifiedTransfer,
      ).not.toHaveBeenCalled();
      expect(newDeviceCap.check).not.toHaveBeenCalled();
    });
  });
});
