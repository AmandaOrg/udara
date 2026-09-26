import {
  BillPaymentCategory,
  BillPaymentStatus,
} from "../prisma/bill-payment.enums";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { TransactionType } from "../common/enums/transaction-type.enum";
import { whatsappTestMessenger } from "../messaging/testing/whatsapp-test-messenger";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { runInChannel } from "../messaging/channel-context";

describe("BillPaymentConfirmationService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    billPayment: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let allowance: {
    evaluateSpend: jest.Mock;
    recordBillPaymentSpend: jest.Mock;
  };
  let rubies: { getBalance: jest.Mock; purchaseVas: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendInteractiveButtons: jest.Mock };
  let pinGate: {
    requestBillPaymentPin: jest.Mock;
    requestPinSetup: jest.Mock;
    isLocked: jest.Mock;
    notifyLocked: jest.Mock;
  };
  let service: BillPaymentConfirmationService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    rubiesAccountNumber: "7712345678",
    rubiesAccountName: "Test User",
    pinHash: "hash",
  };

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user) },
      billPayment: {
        create: jest.fn().mockResolvedValue({ id: "bill-1" }),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
        // Status transitions are conditional claims; count 1 means this caller
        // won the race. See TransferConfirmationService.claimStatus.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    allowance = {
      evaluateSpend: jest.fn().mockResolvedValue({
        type: TransactionType.NORMAL,
        feeAmount: 0,
        waived: false,
        remainingToday: 5000,
      }),
      recordBillPaymentSpend: jest.fn().mockResolvedValue(undefined),
    };
    rubies = {
      getBalance: jest.fn().mockResolvedValue(10000),
      purchaseVas: jest.fn(),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue(undefined),
      sendInteractiveButtons: jest.fn().mockResolvedValue(undefined),
    };
    pinGate = {
      requestBillPaymentPin: jest.fn(),
      requestPinSetup: jest.fn(),
      isLocked: jest.fn().mockReturnValue(false),
      notifyLocked: jest.fn(),
    };
    service = new BillPaymentConfirmationService(
      prisma as never,
      allowance as never,
      rubies as never,
      whatsappTestMessenger({ whatsapp }),
      pinGate as never,
    );
  });

  it("shows data bundle copy on confirm card", async () => {
    await service.initiateBillPayment({
      userId: user.id,
      category: BillPaymentCategory.DATA,
      billerCode: "MTN_DATA",
      productCode: "MTN_1GB",
      telcoLabel: "MTN",
      msisdn: "08012345678",
      amount: 1500,
      productLabel: "1GB daily",
    });

    expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
      user.whatsappNumber,
      expect.stringContaining("Buy 1GB daily (₦1,500) for 08012345678 on MTN?"),
      expect.any(Array),
      user.id,
    );
  });

  it("records which channel the purchase was quoted on", async () => {
    await runInChannel({ channel: "app", deviceId: "d1" }, () =>
      service.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.AIRTIME,
        billerCode: "MTN",
        productCode: "MTN_VTU",
        telcoLabel: "MTN",
        msisdn: "08012345678",
        amount: 500,
      }),
    );

    expect(prisma.billPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ originChannel: "APP" }),
    });
  });

  it("shows verified customer name on electricity confirm card", async () => {
    await service.initiateBillPayment({
      userId: user.id,
      category: BillPaymentCategory.ELECTRICITY,
      billerCode: "IKEDC",
      productCode: "IKEDC_PREPAID",
      telcoLabel: "IKEDC",
      msisdn: "45012345678",
      amount: 3000,
      customerName: "JOHN DOE",
    });

    expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
      user.whatsappNumber,
      expect.stringContaining(
        "Buy ₦3,000 prepaid electricity for JOHN DOE (45012345678) on IKEDC?",
      ),
      expect.any(Array),
      user.id,
    );
  });

  it("includes electricity token in success message", async () => {
    prisma.billPayment.findUniqueOrThrow.mockResolvedValue({
      id: "bill-1",
      status: BillPaymentStatus.CONFIRMED,
      category: BillPaymentCategory.ELECTRICITY,
      amount: 3000,
      telcoLabel: "IKEDC",
      msisdn: "45012345678",
      productLabel: null,
      vendorToken: null,
      user,
    });

    await service.applyBillPaymentResult(
      "bill-1",
      "SUCCESS",
      "RUB-123",
      "1234-5678-9012",
    );

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      user.whatsappNumber,
      expect.stringContaining("Token: 1234-5678-9012"),
      user.id,
    );
    expect(prisma.billPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bill-1", status: BillPaymentStatus.CONFIRMED },
        data: expect.objectContaining({ vendorToken: "1234-5678-9012" }),
      }),
    );
  });

  it("sends a purchase's result back to the channel it was made on", async () => {
    const send = jest.spyOn(ChannelMessenger.prototype, "sendText");
    prisma.billPayment.findUniqueOrThrow.mockResolvedValue({
      id: "bill-1",
      status: BillPaymentStatus.CONFIRMED,
      category: BillPaymentCategory.AIRTIME,
      amount: 1000,
      telcoLabel: "MTN",
      msisdn: "08012345678",
      productLabel: null,
      vendorToken: null,
      originChannel: "APP",
      user,
    });

    await service.applyBillPaymentResult("bill-1", "FAILED", "RUB-1");

    expect(send).toHaveBeenCalledWith(user, expect.any(String), {
      delivery: "transactional",
      origin: "app",
    });
    send.mockRestore();
  });

  function pendingBill(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "bill-1",
      userId: user.id,
      status: BillPaymentStatus.PENDING_CONFIRMATION,
      category: BillPaymentCategory.AIRTIME,
      amount: 1000,
      feeAmount: 0,
      type: TransactionType.NORMAL,
      telcoLabel: "MTN",
      msisdn: "08012345678",
      productLabel: null,
      customerName: null,
      // Fresh by default; the re-quote tests age it.
      createdAt: new Date(),
      user,
      ...overrides,
    };
  }

  describe("confirmBillPayment", () => {
    /**
     * The id comes from a button payload. Once a client other than WhatsApp can
     * name it, an unscoped lookup would let one user confirm another's purchase.
     */
    it("only looks the purchase up within the caller's own purchases", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(null);

      await service.confirmBillPayment("someone-else", "bill-1");

      expect(prisma.billPayment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bill-1", userId: "someone-else" },
        }),
      );
      expect(rubies.getBalance).not.toHaveBeenCalled();
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalled();
      expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
    });

    it("asks for the PIN when the quote is fresh and its terms still hold", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(pendingBill());

      await service.confirmBillPayment(user.id, "bill-1");

      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", status: BillPaymentStatus.PENDING_CONFIRMATION },
        data: { status: BillPaymentStatus.PENDING_PIN },
      });
      expect(pinGate.requestBillPaymentPin).toHaveBeenCalledWith(
        user,
        "bill-1",
      );
      expect(whatsapp.sendInteractiveButtons).not.toHaveBeenCalled();
    });

    /**
     * Fee and spend type are frozen at quote time. Without a re-quote a user
     * could sit on Confirm until the window closed and still buy at zero fee.
     */
    it("re-quotes a purchase that sat too long instead of asking for the PIN", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(
        pendingBill({ createdAt: new Date(Date.now() - 11 * 60 * 1000) }),
      );

      await service.confirmBillPayment(user.id, "bill-1");

      expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: BillPaymentStatus.PENDING_PIN },
        }),
      );
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        user.whatsappNumber,
        expect.stringContaining("waiting a while"),
        [
          { id: "confirm_bill:bill-1", title: "Confirm" },
          { id: "cancel_bill:bill-1", title: "Cancel" },
        ],
        user.id,
      );
    });

    it("re-quotes when the fee changed since the quote, and stores the new terms", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(pendingBill());
      allowance.evaluateSpend.mockResolvedValue({
        type: TransactionType.EARLY_ACCESS,
        feeAmount: 1002,
        waived: false,
        remainingToday: 5000,
      });

      await service.confirmBillPayment(user.id, "bill-1");

      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", status: BillPaymentStatus.PENDING_CONFIRMATION },
        data: { type: TransactionType.EARLY_ACCESS, feeAmount: 1002 },
      });
      const [, body] = whatsapp.sendInteractiveButtons.mock.calls[0];
      expect(body).toContain("terms on this one moved");
      expect(body).toContain("Buy ₦1,000 MTN airtime for 08012345678?");
      expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
    });
  });

  describe("cancelBillPayment", () => {
    it("cancels through an atomic claim, not a blind update", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(pendingBill());

      await service.cancelBillPayment(user.id, "bill-1");

      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", status: BillPaymentStatus.PENDING_CONFIRMATION },
        data: { status: BillPaymentStatus.CANCELLED },
      });
      expect(prisma.billPayment.update).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        user.whatsappNumber,
        "Cancelled, no airtime was bought.",
        user.id,
      );
    });

    it("stays quiet when a racing Confirm claimed the row first", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(pendingBill());
      prisma.billPayment.updateMany.mockResolvedValue({ count: 0 });

      await service.cancelBillPayment(user.id, "bill-1");

      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it("cannot cancel another user's purchase", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(null);

      await service.cancelBillPayment("someone-else", "bill-1");

      expect(prisma.billPayment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bill-1", userId: "someone-else" },
        }),
      );
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("cancelPendingForUser", () => {
    /**
     * A PIN-awaiting purchase carries a live challenge. Leaving it behind meant
     * answering that challenge later could still buy something the user had
     * walked away from.
     */
    it("also cancels a purchase waiting on the PIN, and says so even when silent", async () => {
      prisma.billPayment.findMany.mockResolvedValue([
        pendingBill({ status: BillPaymentStatus.PENDING_PIN }),
      ]);

      await service.cancelPendingForUser(user.id, { silent: true });

      expect(prisma.billPayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            status: {
              in: [
                BillPaymentStatus.PENDING_CONFIRMATION,
                BillPaymentStatus.PENDING_PIN,
              ],
            },
          },
        }),
      );
      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", status: BillPaymentStatus.PENDING_PIN },
        data: { status: BillPaymentStatus.CANCELLED },
      });
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        user.whatsappNumber,
        "Cancelled, no airtime was bought.",
        user.id,
      );
    });

    it("drops a merely-quoted purchase silently when asked to", async () => {
      prisma.billPayment.findMany.mockResolvedValue([pendingBill()]);

      await service.cancelPendingForUser(user.id, { silent: true });

      expect(prisma.billPayment.updateMany).toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });
});
