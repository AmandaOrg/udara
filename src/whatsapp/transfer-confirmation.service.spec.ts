import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
  formatSpendFeeLine,
} from "./transfer-confirmation.service";
import {
  OnboardingStage,
  RecipientLabel,
  TransactionStatus,
} from "@prisma/client";
import { TransactionType } from "../common/enums/transaction-type.enum";
import { whatsappTestMessenger } from "../messaging/testing/whatsapp-test-messenger";

describe("formatSpendFeeLine", () => {
  it("uses plain language instead of enum names", () => {
    expect(formatSpendFeeLine(TransactionType.BORROWED, 1020, false)).toContain(
      "borrowing from future allowance",
    );
    expect(
      formatSpendFeeLine(TransactionType.BORROWED, 1020, false),
    ).not.toContain("BORROWED");
    expect(
      formatSpendFeeLine(TransactionType.EARLY_ACCESS, 1020, false),
    ).toContain("outside spending window");
  });

  it("returns null for NORMAL spends", () => {
    expect(formatSpendFeeLine(TransactionType.NORMAL, 0, false)).toBeNull();
  });
});

describe("TransferConfirmationService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    transaction: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    overrideHistory: { create: jest.Mock };
    dailyAllowance: { findMany: jest.Mock };
    conversationSession: { findFirst: jest.Mock; update: jest.Mock };
    transferDraft: { updateMany: jest.Mock };
  };
  let allowance: {
    evaluateSpend: jest.Mock;
    recordSpend: jest.Mock;
    getOrCreateTodayAllowance: jest.Mock;
  };
  let rubies: {
    nameEnquiry: jest.Mock;
    getBalance: jest.Mock;
    initiateTransfer: jest.Mock;
  };
  let tagging: {
    findRecipient: jest.Mock;
    tagRecipient: jest.Mock;
    touchRecipientUsed: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock; sendInteractiveButtons: jest.Mock };
  let config: { get: jest.Mock };
  let pinGate: {
    requestTransferPin: jest.Mock;
    requestPinSetup: jest.Mock;
    isLocked: jest.Mock;
    notifyLocked: jest.Mock;
  };
  let emailNotifications: { sendMoneyOut: jest.Mock };
  let service: TransferConfirmationService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    rubiesAccountNumber: "7712345678",
    rubiesAccountName: "Test Sender",
    // A PIN is on file by default; the "first transfer, no PIN yet" branch
    // is exercised explicitly where it matters.
    pinHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  };
  const recipient = {
    id: "recipient-1",
    accountNumber: "0011223344",
    bankCode: "000005",
    accountName: "Jane Doe",
    label: RecipientLabel.OTHER,
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      transaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        // Money-state transitions are conditional claims, not blind updates:
        // `updateMany({ where: { id, status: <expected> } })` returning count 1
        // means this caller won the race. Default to winning; individual tests
        // override with { count: 0 } to exercise the loser path.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      overrideHistory: { create: jest.fn() },
      dailyAllowance: { findMany: jest.fn().mockResolvedValue([]) },
      conversationSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      transferDraft: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    allowance = {
      evaluateSpend: jest.fn().mockResolvedValue({
        type: TransactionType.NORMAL,
        remainingToday: 10000,
        withinWindow: true,
        feeAmount: 0,
        waived: false,
        totalCost: 5000,
      }),
      recordSpend: jest.fn(),
      getOrCreateTodayAllowance: jest.fn().mockResolvedValue({
        amountAllocated: 10000,
        surplusCarriedIn: 0,
        amountSpent: 5000,
        weekStartDate: new Date(2026, 0, 5),
      }),
    };
    rubies = {
      nameEnquiry: jest.fn().mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "Access Bank",
      }),
      getBalance: jest.fn().mockResolvedValue(1_000_000),
      initiateTransfer: jest.fn().mockResolvedValue({
        reference: "REF-1",
        status: "SUCCESS",
        responseCode: "00",
      }),
    };
    tagging = {
      findRecipient: jest.fn().mockResolvedValue(recipient),
      tagRecipient: jest.fn().mockResolvedValue(recipient),
      touchRecipientUsed: jest.fn().mockResolvedValue(undefined),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendInteractiveButtons: jest
        .fn()
        .mockResolvedValue({ waMessageId: "wamid.2" }),
    };
    // Unset by default — matches the real "fee sweep skipped with a warning"
    // dev-mode behavior. Individual tests override this to exercise the sweep.
    config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };

    emailNotifications = {
      sendMoneyOut: jest.fn().mockResolvedValue(undefined),
    };
    pinGate = {
      requestTransferPin: jest.fn().mockResolvedValue(undefined),
      requestPinSetup: jest.fn().mockResolvedValue(undefined),
      isLocked: jest.fn().mockReturnValue(false),
      notifyLocked: jest.fn().mockResolvedValue(undefined),
    };

    service = new TransferConfirmationService(
      prisma as any,
      config as any,
      allowance as any,
      rubies as any,
      tagging as any,
      whatsappTestMessenger({ whatsapp }),
      pinGate as any,
      emailNotifications as any,
    );
  });

  describe("initiateTransfer", () => {
    it("bails out early with a message if the user has no Rubies account yet", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...user,
        rubiesAccountNumber: null,
      });

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0011223344",
        bankCode: "000005",
        amount: 5000,
      });

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("don't have a udara account"),
        "user-1",
      );
      expect(allowance.evaluateSpend).not.toHaveBeenCalled();
    });

    it("reuses an existing recipient without calling nameEnquiry/tagRecipient", async () => {
      prisma.transaction.create.mockResolvedValue({ id: "txn-1" });

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0011223344",
        bankCode: "000005",
        amount: 5000,
        purposeLabel: RecipientLabel.RENT,
        label: RecipientLabel.VENDOR,
      });

      expect(rubies.nameEnquiry).not.toHaveBeenCalled();
      expect(tagging.tagRecipient).not.toHaveBeenCalled();
      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purposeLabel: RecipientLabel.RENT,
          }),
        }),
      );
    });

    it("resolves and auto-tags a new recipient as OTHER", async () => {
      tagging.findRecipient.mockResolvedValue(null);
      prisma.transaction.create.mockResolvedValue({ id: "txn-1" });

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0099998888",
        bankCode: "000004",
        amount: 2000,
      });

      expect(rubies.nameEnquiry).toHaveBeenCalledWith({
        accountNumber: "0099998888",
        bankCode: "000004",
      });
      expect(tagging.tagRecipient).toHaveBeenCalledWith(
        expect.objectContaining({
          label: RecipientLabel.OTHER,
          accountName: "Jane Doe",
        }),
      );
    });

    it("stops and informs the user if the new recipient can't be resolved", async () => {
      tagging.findRecipient.mockResolvedValue(null);
      rubies.nameEnquiry.mockRejectedValue(
        new Error("Could not find wallet details"),
      );

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0000000000",
        bankCode: "000099",
        amount: 2000,
      });

      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("Couldn't verify"),
        "user-1",
      );
    });

    it("creates a PENDING_CONFIRMATION transaction and sends confirm/cancel buttons", async () => {
      prisma.transaction.create.mockResolvedValue({ id: "txn-1" });
      rubies.getBalance.mockResolvedValue(1000);

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0011223344",
        bankCode: "000005",
        amount: 800,
        purposeLabel: RecipientLabel.FOOD,
      });

      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransactionStatus.PENDING_CONFIRMATION,
            amount: 800,
            purposeLabel: RecipientLabel.FOOD,
            idempotencyKey: expect.any(String),
          }),
        }),
      );
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        "234801",
        expect.stringMatching(
          /Account balance after this: ₦200[\s\S]*Allowance left today after this/i,
        ),
        [
          { id: `${CONFIRM_BUTTON_PREFIX}txn-1`, title: "Confirm" },
          { id: `${CANCEL_BUTTON_PREFIX}txn-1`, title: "Cancel" },
        ],
        "user-1",
      );
    });

    it("never routes through the fee/window classification decision itself — evaluateSpend's result is trusted as-is", async () => {
      allowance.evaluateSpend.mockResolvedValue({
        type: TransactionType.EARLY_ACCESS,
        remainingToday: 0,
        withinWindow: false,
        feeAmount: 1020,
        waived: false,
        totalCost: 6020,
      });
      prisma.transaction.create.mockResolvedValue({ id: "txn-1" });

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0011223344",
        bankCode: "000005",
        amount: 5000,
      });

      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: TransactionType.EARLY_ACCESS,
            feeAmount: 1020,
          }),
        }),
      );
    });
  });

  describe("confirmTransfer", () => {
    function pendingTransaction(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      return {
        id: "txn-1",
        status: TransactionStatus.PENDING_CONFIRMATION,
        amount: 5000,
        feeAmount: 0,
        type: TransactionType.NORMAL,
        idempotencyKey: "idem-1",
        // Fresh by default. confirmTransfer re-quotes a transfer that has sat
        // too long rather than executing on the figures the user saw back then.
        createdAt: new Date(),
        user,
        recipient,
        ...overrides,
      };
    }

    it("is a no-op if the transaction doesn't exist", async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await service.confirmTransfer("user-1", "nope");
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    /**
     * The id comes from a button payload. Once a client other than WhatsApp can
     * name it, an unscoped lookup would let one user confirm another's transfer.
     */
    it("only looks the transaction up within the caller's own transactions", async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);

      await service.confirmTransfer("someone-else", "txn-1");

      expect(prisma.transaction.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "txn-1", userId: "someone-else" },
        }),
      );
      expect(rubies.getBalance).not.toHaveBeenCalled();
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
      expect(pinGate.requestTransferPin).not.toHaveBeenCalled();
    });

    it("is a no-op (idempotent) if already actioned — not PENDING_CONFIRMATION", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.EXECUTED }),
      );
      await service.confirmTransfer("user-1", "txn-1");
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("fails cleanly on insufficient balance without calling Rubies transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ amount: 5000, feeAmount: 1000 }),
      );
      rubies.getBalance.mockResolvedValue(1000); // less than 6000 total

      await service.confirmTransfer("user-1", "txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          id: "txn-1",
          status: TransactionStatus.PENDING_CONFIRMATION,
        },
        data: { status: TransactionStatus.FAILED },
      });
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("only has"),
        "user-1",
      );
    });

    /**
     * A Rubies blip on the pre-authorisation balance check used to throw all the
     * way out to WhatsappController, which logged it and marked the message
     * FAILED — so the user tapped Confirm and got nothing at all. The row is
     * untouched at that point, so the Confirm button is still live and the right
     * answer is to say so.
     */
    it("asks the user to retry, rather than going silent, when the balance check fails", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      rubies.getBalance.mockRejectedValue(new Error("Could not reach Rubies"));

      await expect(
        service.confirmTransfer("user-1", "txn-1"),
      ).resolves.toBeUndefined();

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("tap confirm again"),
        "user-1",
      );
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      // Critically: the row must NOT be moved to FAILED — nothing is known yet.
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    });

    it("does NOT create an OverrideHistory row for a NORMAL transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );

      await service.confirmTransfer("user-1", "txn-1");

      expect(prisma.overrideHistory.create).not.toHaveBeenCalled();
    });
  });

  describe("PIN gate — confirmTransfer must never move money on its own", () => {
    function pendingTransaction(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      return {
        id: "txn-1",
        status: TransactionStatus.PENDING_CONFIRMATION,
        amount: 5000,
        feeAmount: 0,
        type: TransactionType.NORMAL,
        idempotencyKey: "idem-1",
        // Fresh by default. confirmTransfer re-quotes a transfer that has sat
        // too long rather than executing on the figures the user saw back then.
        createdAt: new Date(),
        user,
        recipient,
        ...overrides,
      };
    }

    it("asks for a PIN instead of transferring, once all other guards pass", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());

      await service.confirmTransfer("user-1", "txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(pinGate.requestTransferPin).toHaveBeenCalledWith(user, "txn-1");
      // Claimed from PENDING_CONFIRMATION, so a second Confirm tap arriving
      // concurrently cannot mint a second PIN challenge for the same transfer.
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          id: "txn-1",
          status: TransactionStatus.PENDING_CONFIRMATION,
        },
        data: { status: TransactionStatus.PENDING_PIN },
      });
    });

    /**
     * The spend type and fee were frozen when the transfer was proposed and
     * never re-checked, so a user could set one up inside the spending window,
     * sit on the Confirm button until it closed, and still send at the old
     * zero-fee terms. Several sends could likewise each fit the allowance when
     * proposed and all execute.
     */
    it("re-quotes instead of executing when the fee changed while it waited", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      rubies.getBalance.mockResolvedValue(50_000);
      allowance.evaluateSpend.mockResolvedValue({
        type: TransactionType.EARLY_ACCESS,
        feeAmount: 1010,
        waived: false,
        remainingToday: 10_000,
      });

      await service.confirmTransfer("user-1", "txn-1");

      // No PIN, no money — the row stays PENDING_CONFIRMATION and the customer
      // is shown the terms they would actually be authorising.
      expect(pinGate.requestTransferPin).not.toHaveBeenCalled();
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ feeAmount: 1010 }),
        }),
      );
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("moved while it was waiting"),
        expect.any(Array),
        "user-1",
      );
    });

    it("re-quotes a transfer that has been sitting too long, even on unchanged terms", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
        }),
      );
      rubies.getBalance.mockResolvedValue(50_000);

      await service.confirmTransfer("user-1", "txn-1");

      expect(pinGate.requestTransferPin).not.toHaveBeenCalled();
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("waiting a while"),
        expect.any(Array),
        "user-1",
      );
    });

    it("does not open a PIN challenge when another handler already claimed the transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      rubies.getBalance.mockResolvedValue(50_000);
      prisma.transaction.updateMany.mockResolvedValue({ count: 0 });

      await service.confirmTransfer("user-1", "txn-1");

      expect(pinGate.requestTransferPin).not.toHaveBeenCalled();
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("sends the setup form, and does not transfer, when the user has no PIN yet", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ user: { ...user, pinHash: null } }),
      );

      await service.confirmTransfer("user-1", "txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(pinGate.requestPinSetup).toHaveBeenCalled();
      expect(pinGate.requestTransferPin).not.toHaveBeenCalled();
    });

    it("resumeAfterPinSetup continues the pending confirm into PIN entry", async () => {
      prisma.transaction.findFirst.mockResolvedValue(
        pendingTransaction({ user: { ...user, pinHash: "scrypt$hash" } }),
      );
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ user: { ...user, pinHash: "scrypt$hash" } }),
      );

      await service.resumeAfterPinSetup("user-1");

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("enter your PIN"),
        "user-1",
      );
      expect(pinGate.requestTransferPin).toHaveBeenCalled();
    });

    it("resumePendingTransferUi does not start a new transfer", async () => {
      prisma.transaction.findFirst.mockResolvedValue(pendingTransaction());
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());

      const handled = await service.resumePendingTransferUi(user as any);

      expect(handled).toBe(true);
      expect(pinGate.requestTransferPin).toHaveBeenCalledWith(user, "txn-1");
    });

    it("refuses and cancels, without transferring, when the PIN is locked", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      pinGate.isLocked.mockReturnValue(true);

      await service.confirmTransfer("user-1", "txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(pinGate.notifyLocked).toHaveBeenCalled();
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          id: "txn-1",
          status: TransactionStatus.PENDING_CONFIRMATION,
        },
        data: { status: TransactionStatus.CANCELLED },
      });
    });

    it("refuses to execute a transaction that never passed through the PIN gate", async () => {
      // Still PENDING_CONFIRMATION: someone reached the execute path directly.
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());

      await service.executeVerifiedTransfer("txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("refuses to execute an already-executed transaction (no double spend on replay)", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.EXECUTED }),
      );

      await service.executeVerifiedTransfer("txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("is a no-op for an unknown transaction id", async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await service.executeVerifiedTransfer("nope");
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });
  });

  describe("executeVerifiedTransfer (PIN already verified)", () => {
    function pendingTransaction(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      return {
        id: "txn-1",
        status: TransactionStatus.PENDING_PIN,
        amount: 5000,
        feeAmount: 0,
        type: TransactionType.NORMAL,
        idempotencyKey: "idem-1",
        user,
        recipient,
        ...overrides,
      };
    }

    it("marks CONFIRMED before calling Rubies, then EXECUTED on SUCCESS, and records the spend", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.PENDING_PIN }),
      );
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "SUCCESS",
        responseCode: "00",
      });

      await service.executeVerifiedTransfer("txn-1");

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: TransactionStatus.PENDING_PIN },
        data: expect.objectContaining({
          status: TransactionStatus.CONFIRMED,
        }),
      });
      expect(rubies.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAccountNumber: "7712345678",
          toAccountNumber: "0011223344",
          idempotencyKey: "idem-1",
        }),
      );
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: TransactionStatus.CONFIRMED },
        data: expect.objectContaining({ status: TransactionStatus.EXECUTED }),
      });
      expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("Done"),
        "user-1",
      );
    });

    it("creates an OverrideHistory row for a non-NORMAL EXECUTED transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({
          status: TransactionStatus.PENDING_PIN,
          type: TransactionType.EARLY_ACCESS,
          feeAmount: 1020,
        }),
      );
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({
          type: TransactionType.EARLY_ACCESS,
          feeAmount: 1020,
          status: TransactionStatus.CONFIRMED,
        }),
      );

      await service.executeVerifiedTransfer("txn-1");

      expect(prisma.overrideHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: TransactionType.EARLY_ACCESS,
            feeAmount: 1020,
          }),
        }),
      );
    });

    it("marks FAILED and does not record spend when Rubies reports FAILED", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.PENDING_PIN }),
      );
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "FAILED",
        responseCode: "25",
      });

      await service.executeVerifiedTransfer("txn-1");

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: TransactionStatus.CONFIRMED },
        data: expect.objectContaining({ status: TransactionStatus.FAILED }),
      });
      expect(allowance.recordSpend).not.toHaveBeenCalled();
    });

    it("leaves the transaction CONFIRMED (not EXECUTED/FAILED) when Rubies reports PENDING, for the reconciliation job to resolve later", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.PENDING_PIN }),
      );
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "PENDING",
        responseCode: "09",
      });

      await service.executeVerifiedTransfer("txn-1");

      // Only the one CONFIRMED claim — no second claim pushing it to EXECUTED/FAILED.
      expect(prisma.transaction.updateMany).toHaveBeenCalledTimes(1);
      expect(allowance.recordSpend).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("processing"),
        "user-1",
      );
    });
  });

  describe("cancelTransfer", () => {
    it("cancels a PENDING_CONFIRMATION transaction", async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.PENDING_CONFIRMATION,
        user,
      });

      await service.cancelTransfer("user-1", "txn-1");

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          id: "txn-1",
          status: TransactionStatus.PENDING_CONFIRMATION,
        },
        data: { status: TransactionStatus.CANCELLED },
      });
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("Cancelled"),
        "user-1",
      );
    });

    it("is a no-op for a transaction that's already been actioned", async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.EXECUTED,
        user,
      });
      await service.cancelTransfer("user-1", "txn-1");
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    });

    it("cannot cancel another user's transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);

      await service.cancelTransfer("someone-else", "txn-1");

      expect(prisma.transaction.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "txn-1", userId: "someone-else" },
        }),
      );
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });

  describe("applyTransferResult", () => {
    /**
     * Three callers can fire for the same transaction — the synchronous path, the
     * Rubies webhook, and the reconciliation scheduler — so the CONFIRMED claim
     * is what stops two of them running the side-effect block twice.
     */
    it("is idempotent — a second call on an already-EXECUTED transaction is a no-op", async () => {
      prisma.transaction.updateMany.mockResolvedValue({ count: 0 });
      prisma.transaction.findUnique.mockResolvedValue({
        status: TransactionStatus.EXECUTED,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(allowance.recordSpend).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    /**
     * A forged or misrouted Rubies webhook must not be able to jump a transfer
     * that is still awaiting its PIN straight to EXECUTED, which would debit the
     * allowance and send a receipt for money that never moved.
     */
    it("refuses a result for a transfer that was never sent, and says so loudly", async () => {
      prisma.transaction.updateMany.mockResolvedValue({ count: 0 });
      prisma.transaction.findUnique.mockResolvedValue({
        status: TransactionStatus.PENDING_PIN,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(allowance.recordSpend).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(prisma.transferDraft.updateMany).not.toHaveBeenCalled();
    });

    it("resolves a still-CONFIRMED transaction to EXECUTED and records the spend", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.CONFIRMED,
        user,
        recipient,
        amount: 5000,
        type: TransactionType.NORMAL,
        feeAmount: 0,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: TransactionStatus.CONFIRMED },
        data: expect.objectContaining({ status: TransactionStatus.EXECUTED }),
      });
      expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
      expect(prisma.transferDraft.updateMany).toHaveBeenCalled();
    });

    it("appends a completed-send fact to the orchestrator chat session", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.CONFIRMED,
        user,
        userId: "user-1",
        recipient,
        amount: 800,
        type: TransactionType.NORMAL,
        feeAmount: 0,
      });
      prisma.conversationSession.findFirst.mockResolvedValue({
        id: "sess-1",
        messages: [{ role: "user", content: "send 800" }],
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(prisma.conversationSession.update).toHaveBeenCalledWith({
        where: { id: "sess-1" },
        data: {
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.stringMatching(/₦800 .+ succeeded/),
            }),
          ]),
        },
      });
    });

    it("completes onboarding (-> COMPLETE) instead of the normal 'Done' message when the user was FUNDED/ACCOUNT_CREATED", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.CONFIRMED,
        user: { ...user, onboardingStage: OnboardingStage.FUNDED },
        userId: "user-1",
        recipient,
        amount: 5000,
        type: TransactionType.NORMAL,
        feeAmount: 0,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({
            onboardingStage: OnboardingStage.COMPLETE,
            onboardingCompletedAt: expect.any(Date),
          }),
        }),
      );
      const [, message] =
        whatsapp.sendText.mock.calls[whatsapp.sendText.mock.calls.length - 1];
      expect(message).toContain("payment successful");
      expect(message).not.toContain("Done,");
    });

    it("sends the normal 'Done' message (no onboarding transition) for an already-COMPLETE user", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.CONFIRMED,
        user: { ...user, onboardingStage: OnboardingStage.COMPLETE },
        userId: "user-1",
        recipient,
        amount: 5000,
        type: TransactionType.NORMAL,
        feeAmount: 0,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(prisma.user.update).not.toHaveBeenCalled();
      const [, message] =
        whatsapp.sendText.mock.calls[whatsapp.sendText.mock.calls.length - 1];
      expect(message).toContain("Done,");
    });

    describe("fee sweep", () => {
      function executedWithFee(
        overrides: Partial<Record<string, unknown>> = {},
      ) {
        return {
          id: "txn-1",
          status: TransactionStatus.CONFIRMED,
          user,
          userId: "user-1",
          recipient,
          amount: 5000,
          type: TransactionType.EARLY_ACCESS,
          feeAmount: 1020,
          idempotencyKey: "idem-1",
          feeSweptAt: null,
          ...overrides,
        };
      }

      it("skips the sweep (with a warning) when RUBIES_FEES_ACCOUNT_NUMBER isn't set — doesn't touch the main flow", async () => {
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee(),
        );

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        // Only the main-flow calls are on this shared mock — no fee-sweep transfer attempted.
        expect(rubies.initiateTransfer).not.toHaveBeenCalled();
        expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
      });

      it("sweeps the fee to the configured fees account and marks it swept on success", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) => {
          if (key === "RUBIES_FEES_ACCOUNT_NUMBER") return "9998887777";
          if (key === "RUBIES_FEES_BANK_CODE") return "090175";
          return fallback;
        });
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee(),
        );
        rubies.initiateTransfer.mockResolvedValue({
          reference: "FEE-REF-1",
          status: "SUCCESS",
          responseCode: "00",
        });

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        expect(rubies.initiateTransfer).toHaveBeenCalledWith(
          expect.objectContaining({
            fromAccountNumber: "7712345678",
            toAccountNumber: "9998887777",
            toBankCode: "090175",
            amount: 1020,
            idempotencyKey: "idem-1-fee",
          }),
        );
        // The reference is written by the lease *before* the call, deterministic
        // so a later status query can find it; feeSweptAt only on success.
        expect(prisma.transaction.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              feeSweepReference: "idem-1-fee",
              feeSweepAttempts: { increment: 1 },
            }),
          }),
        );
        expect(prisma.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ feeSweptAt: expect.any(Date) }),
          }),
        );
      });

      it("does not send a second sweep while one is already leased", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee(),
        );
        // Only the *lease* claim loses — the status claim must still win, or the
        // method would bail before ever reaching the sweep and the test would
        // pass for the wrong reason. The lease is the call keyed on feeSweptAt.
        prisma.transaction.updateMany.mockImplementation(
          (args: { where: Record<string, unknown> }) =>
            Promise.resolve({
              count: "feeSweptAt" in args.where ? 0 : 1,
            }),
        );

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      });

      it("leaves the row unswept and retryable when the sweep comes back PENDING", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee(),
        );
        rubies.initiateTransfer.mockResolvedValue({
          reference: "FEE-REF-2",
          status: "PENDING",
          responseCode: "09",
        });

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        // feeSweptAt is never written on a non-SUCCESS, so the retry job can
        // pick the row up again once the lease expires.
        expect(prisma.transaction.update).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ feeSweptAt: expect.any(Date) }),
          }),
        );
      });

      /**
       * The lease has to stay re-claimable. A claim predicate of
       * "feeSweepReference is null" would match on the very first attempt and
       * never again, so the retry job could never recover the rows it exists for.
       */
      it("retries a fee that never swept, and stops after the attempt ceiling", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findMany.mockResolvedValue([
          { ...executedWithFee(), user },
        ]);
        rubies.initiateTransfer.mockResolvedValue({
          reference: "FEE-REF-3",
          status: "SUCCESS",
          responseCode: "00",
        });

        await service.retryUnsweptFees();

        const where = prisma.transaction.findMany.mock.calls.at(-1)![0].where;
        expect(where).toMatchObject({
          feeSweptAt: null,
          feeSweepAttempts: { lt: 5 },
        });
        // Bounded to a day: the fee debits the customer's own wallet, so a late
        // sweep is a surprise debit against money they have already spent.
        expect(where.executedAt.gte).toBeInstanceOf(Date);
        expect(rubies.initiateTransfer).toHaveBeenCalledWith(
          expect.objectContaining({ idempotencyKey: "idem-1-fee" }),
        );
      });

      it("never lets a sweep failure block recordSpend or the user's confirmation message", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee(),
        );
        rubies.initiateTransfer.mockRejectedValue(new Error("Rubies down"));

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
        expect(whatsapp.sendText).toHaveBeenCalledWith(
          "234801",
          expect.stringContaining("Done"),
          "user-1",
        );
      });

      it("doesn't sweep again once feeSweptAt is already set", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee({ feeSweptAt: new Date() }),
        );

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      });

      it("never attempts a sweep when feeAmount is 0", async () => {
        config.get.mockImplementation((key: string, fallback?: unknown) =>
          key === "RUBIES_FEES_ACCOUNT_NUMBER" ? "9998887777" : fallback,
        );
        prisma.transaction.findUniqueOrThrow.mockResolvedValue(
          executedWithFee({ type: TransactionType.NORMAL, feeAmount: 0 }),
        );

        await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

        expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      });
    });
  });
});
