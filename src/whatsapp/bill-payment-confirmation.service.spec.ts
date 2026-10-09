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
      originSurface: "CHAT",
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
            // Chat purchases only: a native one is the app screen's (P8).
            originSurface: "CHAT",
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
  /**
   * Today's exact WhatsApp output for every quote, confirm and cancel branch,
   * pinned before the decisions were split from their rendering (P8), so the
   * split is proven not to change a word, a button or the order of sends.
   */
  describe("exact WhatsApp output", () => {
    const CONFIRM = { id: "confirm_bill:bill-1", title: "Confirm" };
    const CANCEL = { id: "cancel_bill:bill-1", title: "Cancel" };

    /** Every send, in order, as [text] or [body, buttons]. */
    function sent(): unknown[][] {
      const texts = whatsapp.sendText.mock.calls.map((c, i) => ({
        order: whatsapp.sendText.mock.invocationCallOrder[i],
        entry: [c[1]],
      }));
      const buttons = whatsapp.sendInteractiveButtons.mock.calls.map(
        (c, i) => ({
          order: whatsapp.sendInteractiveButtons.mock.invocationCallOrder[i],
          entry: [c[1], c[2]],
        }),
      );
      return [...texts, ...buttons]
        .sort((a, b) => a.order - b.order)
        .map((s) => s.entry);
    }

    function pending(overrides: Partial<Record<string, unknown>> = {}) {
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
        originSurface: "CHAT",
        createdAt: new Date(),
        user,
        ...overrides,
      };
    }

    const airtime = {
      userId: user.id,
      category: BillPaymentCategory.AIRTIME,
      billerCode: "MTN_AIRTIME",
      productCode: "MTN_AIRTIME_PREPAID",
      telcoLabel: "MTN",
      msisdn: "08012345678",
      amount: 500,
    };

    describe("initiateBillPayment", () => {
      it("no account", async () => {
        prisma.user.findUniqueOrThrow.mockResolvedValue({
          ...user,
          rubiesAccountNumber: null,
        });
        await service.initiateBillPayment(airtime);
        expect(sent()).toEqual([
          ["you don't have a udara account set up yet."],
        ]);
      });

      it("airtime, inside the window", async () => {
        await service.initiateBillPayment(airtime);
        expect(sent()).toEqual([
          [
            "Buy ₦500 MTN airtime for 08012345678?\nAccount balance after this: ₦9,500\nAllowance left today after this: ₦4,500",
            [CONFIRM, CANCEL],
          ],
        ]);
      });

      it("a data bundle", async () => {
        await service.initiateBillPayment({
          ...airtime,
          category: BillPaymentCategory.DATA,
          billerCode: "MTN_DATA",
          productCode: "MTN_DATA_2GB_30D",
          productLabel: "2GB · 30 days",
          amount: 1500,
        });
        expect(sent()).toEqual([
          [
            "Buy 2GB · 30 days (₦1,500) for 08012345678 on MTN?\nAccount balance after this: ₦8,500\nAllowance left today after this: ₦3,500",
            [CONFIRM, CANCEL],
          ],
        ]);
      });

      it("electricity, outside the window, with a fee", async () => {
        allowance.evaluateSpend.mockResolvedValue({
          type: TransactionType.EARLY_ACCESS,
          feeAmount: 1002,
          waived: false,
          remainingToday: 5000,
        });
        await service.initiateBillPayment({
          ...airtime,
          category: BillPaymentCategory.ELECTRICITY,
          billerCode: "IKEDC",
          productCode: "IKEDC_PREPAID",
          telcoLabel: "Ikeja Electric",
          productLabel: "Prepaid electricity",
          msisdn: "45012345678",
          customerName: "JOHN DOE",
          amount: 3000,
        });
        expect(sent()).toEqual([
          [
            "Buy ₦3,000 prepaid electricity for JOHN DOE (45012345678) on Ikeja Electric?\noutside spending window fee: ₦1,002\nAccount balance after this: ₦5,998\nAllowance left today after this: ₦2,000",
            [CONFIRM, CANCEL],
          ],
        ]);
      });

      it("electricity with no name on the meter, and no balance", async () => {
        rubies.getBalance.mockRejectedValue(new Error("down"));
        await service.initiateBillPayment({
          ...airtime,
          category: BillPaymentCategory.ELECTRICITY,
          billerCode: "IKEDC",
          productCode: "IKEDC_PREPAID",
          telcoLabel: "Ikeja Electric",
          msisdn: "45012345678",
          amount: 3000,
        });
        expect(sent()).toEqual([
          [
            "Buy ₦3,000 prepaid electricity for this meter (45012345678) on Ikeja Electric?\nAllowance left today after this: ₦2,000",
            [CONFIRM, CANCEL],
          ],
        ]);
      });
    });

    describe("confirmBillPayment", () => {
      it("the balance cannot be read", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(pending());
        rubies.getBalance.mockRejectedValue(new Error("down"));
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([
          [
            "i couldn't check your balance just now. tap confirm again in a moment.",
          ],
        ]);
      });

      it("not enough money", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(
          pending({ feeAmount: 1000 }),
        );
        rubies.getBalance.mockResolvedValue(1500);
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([
          ["That needs ₦2,000 but your account only has ₦1,500. Cancelled."],
        ]);
      });

      it("the terms moved while it waited", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(pending());
        allowance.evaluateSpend.mockResolvedValue({
          type: TransactionType.EARLY_ACCESS,
          feeAmount: 1002,
          waived: false,
          remainingToday: 5000,
        });
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([
          [
            "the terms on this one moved while it was waiting, so here it is again:\nBuy ₦1,000 MTN airtime for 08012345678?\noutside spending window fee: ₦1,002\nAccount balance after this: ₦7,998\nAllowance left today after this: ₦4,000",
            [CONFIRM, CANCEL],
          ],
        ]);
      });

      it("it waited too long", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(
          pending({ createdAt: new Date(Date.now() - 11 * 60 * 1000) }),
        );
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([
          [
            "this has been waiting a while, so let's confirm it again:\nBuy ₦1,000 MTN airtime for 08012345678?\nAccount balance after this: ₦9,000\nAllowance left today after this: ₦4,000",
            [CONFIRM, CANCEL],
          ],
        ]);
      });

      it("no PIN yet", async () => {
        const noPin = { ...user, pinHash: null };
        prisma.billPayment.findUnique.mockResolvedValue(
          pending({ user: noPin }),
        );
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([
          ["before your first purchase, you need to set a 4-digit pin."],
        ]);
        expect(pinGate.requestPinSetup).toHaveBeenCalledWith(noPin);
      });

      it("the PIN is locked", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(pending());
        pinGate.isLocked.mockReturnValue(true);
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([]);
        expect(pinGate.notifyLocked).toHaveBeenCalledWith(user);
        expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
      });

      it("ready for the PIN", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(pending());
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([]);
        expect(pinGate.requestBillPaymentPin).toHaveBeenCalledWith(
          user,
          "bill-1",
        );
      });

      it("already actioned", async () => {
        prisma.billPayment.findUnique.mockResolvedValue(
          pending({ status: BillPaymentStatus.PENDING_PIN }),
        );
        await service.confirmBillPayment(user.id, "bill-1");
        expect(sent()).toEqual([]);
        expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
      });
    });

    it.each([
      [BillPaymentCategory.AIRTIME, "Cancelled, no airtime was bought."],
      [BillPaymentCategory.DATA, "Cancelled, no data was bought."],
      [
        BillPaymentCategory.ELECTRICITY,
        "Cancelled, no electricity was bought.",
      ],
    ])("cancelBillPayment (%s)", async (category, text) => {
      prisma.billPayment.findUnique.mockResolvedValue(pending({ category }));
      await service.cancelBillPayment(user.id, "bill-1");
      expect(sent()).toEqual([[text]]);
    });

    it("resumeAfterPinSetup, waiting on the PIN", async () => {
      (prisma.billPayment as any).findFirst = jest
        .fn()
        .mockResolvedValue(pending({ status: BillPaymentStatus.PENDING_PIN }));
      await service.resumeAfterPinSetup(user.id);
      expect(sent()).toEqual([]);
      expect(pinGate.requestBillPaymentPin).toHaveBeenCalledWith(
        user,
        "bill-1",
      );
    });

    it("resumeAfterPinSetup, still at the quote", async () => {
      (prisma.billPayment as any).findFirst = jest
        .fn()
        .mockResolvedValue(pending());
      prisma.billPayment.findUnique.mockResolvedValue(pending());
      await service.resumeAfterPinSetup(user.id);
      expect(sent()).toEqual([]);
      expect(pinGate.requestBillPaymentPin).toHaveBeenCalledWith(
        user,
        "bill-1",
      );
    });

    it("cancelPendingForUser, silent, still announces a withdrawn PIN request", async () => {
      prisma.billPayment.findMany.mockResolvedValue([
        pending(),
        pending({
          id: "bill-2",
          status: BillPaymentStatus.PENDING_PIN,
          category: BillPaymentCategory.DATA,
        }),
      ]);
      await service.cancelPendingForUser(user.id, { silent: true });
      expect(sent()).toEqual([["Cancelled, no data was bought."]]);
    });
  });

  /**
   * The app's native bill screens (P8) use the same decisions, answered as
   * data, and their purchases are invisible to every chat path.
   */
  describe("native purchases", () => {
    function row(overrides: Partial<Record<string, unknown>> = {}) {
      return pendingBill({
        id: "bill-9",
        originSurface: "NATIVE",
        ...overrides,
      });
    }

    function nothingSent() {
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(whatsapp.sendInteractiveButtons).not.toHaveBeenCalled();
      expect(pinGate.requestBillPaymentPin).not.toHaveBeenCalled();
      expect(pinGate.requestPinSetup).not.toHaveBeenCalled();
      expect(pinGate.notifyLocked).not.toHaveBeenCalled();
    }

    const quote = {
      userId: user.id,
      category: BillPaymentCategory.AIRTIME,
      billerCode: "MTN_AIRTIME",
      productCode: "MTN_AIRTIME_PREPAID",
      telcoLabel: "MTN",
      msisdn: "08012345678",
      amount: 500,
    };

    it("createQuote records the surface and the app's key, and says nothing", async () => {
      prisma.billPayment.create.mockResolvedValue({ id: "bill-9" });

      const result = await service.createQuote({
        ...quote,
        surface: "NATIVE" as any,
        clientRequestKey: "key-12345678",
      });

      expect(result).toMatchObject({ ok: true, balance: 10000 });
      const data = prisma.billPayment.create.mock.calls[0][0].data;
      expect(data.originSurface).toBe("NATIVE");
      expect(data.clientRequestKey).toBe("key-12345678");
      // What Rubies deduplicates on stays the server's own.
      expect(data.requestReference).toMatch(/^UDARA-BILL-/);
      expect(data.idempotencyKey).toBe(data.requestReference);
      nothingSent();
    });

    it("createQuote reports a missing account as data", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...user,
        rubiesAccountNumber: null,
      });
      await expect(service.createQuote(quote)).resolves.toMatchObject({
        ok: false,
        reason: "no_account",
      });
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      nothingSent();
    });

    it("evaluateConfirm claims PENDING_PIN and leaves the PIN to the caller", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(row());

      const decision = await service.evaluateConfirm(
        user.id,
        "bill-9",
        "NATIVE" as any,
      );

      expect(decision.kind).toBe("pin_required");
      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-9", status: BillPaymentStatus.PENDING_CONFIRMATION },
        data: { status: BillPaymentStatus.PENDING_PIN },
      });
      nothingSent();
    });

    it.each([
      [
        "insufficient_funds",
        () => rubies.getBalance.mockResolvedValue(10),
        { needed: 1000, balance: 10 },
      ],
      [
        "balance_unavailable",
        () => rubies.getBalance.mockRejectedValue(new Error("down")),
        {},
      ],
      [
        "pin_setup_required",
        () =>
          prisma.billPayment.findUnique.mockResolvedValue(
            row({ user: { ...user, pinHash: null } }),
          ),
        {},
      ],
      ["locked", () => pinGate.isLocked.mockReturnValue(true), {}],
      [
        "requoted",
        () =>
          prisma.billPayment.findUnique.mockResolvedValue(
            row({ createdAt: new Date(Date.now() - 11 * 60 * 1000) }),
          ),
        { reason: "stale", balance: 10000 },
      ],
    ])("evaluateConfirm answers %s as data", async (kind, arrange, extra) => {
      prisma.billPayment.findUnique.mockResolvedValue(row());
      arrange();

      const decision = await service.evaluateConfirm(
        user.id,
        "bill-9",
        "NATIVE" as any,
      );

      expect(decision).toMatchObject({ kind, ...extra });
      nothingSent();
    });

    it("the chat's Confirm button cannot confirm a native purchase, and the native route cannot confirm a chat one", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(row());
      await service.confirmBillPayment(user.id, "bill-9");

      prisma.billPayment.findUnique.mockResolvedValue(
        row({ originSurface: "CHAT" }),
      );
      const native = await service.evaluateConfirm(
        user.id,
        "bill-9",
        "NATIVE" as any,
      );

      expect(native).toEqual({ kind: "not_found" });
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalled();
      expect(rubies.getBalance).not.toHaveBeenCalled();
      nothingSent();
    });

    it("the chat's Cancel button cannot cancel a native purchase", async () => {
      prisma.billPayment.findUnique.mockResolvedValue(row());
      await service.cancelBillPayment(user.id, "bill-9");
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalled();
      nothingSent();
    });

    it("resuming after a new PIN only looks at chat purchases", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      (prisma.billPayment as any).findFirst = findFirst;

      await service.resumeAfterPinSetup(user.id);

      expect(findFirst.mock.calls[0][0].where.originSurface).toBe("CHAT");
    });

    it("withdraw cancels a native purchase waiting on its PIN, silently", async () => {
      (prisma.billPayment as any).findFirst = jest
        .fn()
        .mockResolvedValue({ status: BillPaymentStatus.PENDING_PIN });

      await expect(service.withdraw(user.id, "bill-9")).resolves.toBe(true);

      expect((prisma.billPayment as any).findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bill-9", userId: user.id, originSurface: "NATIVE" },
        }),
      );
      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-9", status: BillPaymentStatus.PENDING_PIN },
        data: { status: BillPaymentStatus.CANCELLED },
      });
      nothingSent();
    });

    it("withdraw leaves anything past the PIN alone", async () => {
      (prisma.billPayment as any).findFirst = jest
        .fn()
        .mockResolvedValueOnce({ status: BillPaymentStatus.CONFIRMED })
        .mockResolvedValueOnce(null);
      await expect(service.withdraw(user.id, "bill-9")).resolves.toBe(false);
      await expect(service.withdraw(user.id, "bill-9")).resolves.toBe(false);
      expect(prisma.billPayment.updateMany).not.toHaveBeenCalled();
    });
  });
});
