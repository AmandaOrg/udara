import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "./transfer-confirmation.service";
import { RecipientLabel, TransactionStatus } from "@prisma/client";
import { TransactionType } from "../common/enums/transaction-type.enum";

describe("TransferConfirmationService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    transaction: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    overrideHistory: { create: jest.Mock };
  };
  let allowance: { evaluateSpend: jest.Mock; recordSpend: jest.Mock };
  let rubies: {
    nameEnquiry: jest.Mock;
    getBalance: jest.Mock;
    initiateTransfer: jest.Mock;
  };
  let tagging: { findRecipient: jest.Mock; tagRecipient: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendInteractiveButtons: jest.Mock };
  let service: TransferConfirmationService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    rubiesAccountNumber: "7712345678",
    rubiesAccountName: "Test Sender",
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
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user) },
      transaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      overrideHistory: { create: jest.fn() },
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
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendInteractiveButtons: jest
        .fn()
        .mockResolvedValue({ waMessageId: "wamid.2" }),
    };

    service = new TransferConfirmationService(
      prisma as any,
      allowance as any,
      rubies as any,
      tagging as any,
      whatsapp as any,
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
        expect.stringContaining("don't have a Kedu account"),
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
      });

      expect(rubies.nameEnquiry).not.toHaveBeenCalled();
      expect(tagging.tagRecipient).not.toHaveBeenCalled();
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

      await service.initiateTransfer({
        userId: "user-1",
        accountNumber: "0011223344",
        bankCode: "000005",
        amount: 5000,
      });

      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransactionStatus.PENDING_CONFIRMATION,
            amount: 5000,
            idempotencyKey: expect.any(String),
          }),
        }),
      );
      expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
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
        user,
        recipient,
        ...overrides,
      };
    }

    it("is a no-op if the transaction doesn't exist", async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await service.confirmTransfer("nope");
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("is a no-op (idempotent) if already actioned — not PENDING_CONFIRMATION", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.EXECUTED }),
      );
      await service.confirmTransfer("txn-1");
      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
    });

    it("fails cleanly on insufficient balance without calling Rubies transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(
        pendingTransaction({ amount: 5000, feeAmount: 1000 }),
      );
      rubies.getBalance.mockResolvedValue(1000); // less than 6000 total

      await service.confirmTransfer("txn-1");

      expect(rubies.initiateTransfer).not.toHaveBeenCalled();
      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: TransactionStatus.FAILED } }),
      );
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("only has"),
        "user-1",
      );
    });

    it("marks CONFIRMED before calling Rubies, then EXECUTED on SUCCESS, and records the spend", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "SUCCESS",
        responseCode: "00",
      });

      await service.confirmTransfer("txn-1");

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransactionStatus.CONFIRMED,
          }),
        }),
      );
      expect(rubies.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAccountNumber: "7712345678",
          toAccountNumber: "0011223344",
          idempotencyKey: "idem-1",
        }),
      );
      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransactionStatus.EXECUTED }),
        }),
      );
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

      await service.confirmTransfer("txn-1");

      expect(prisma.overrideHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: TransactionType.EARLY_ACCESS,
            feeAmount: 1020,
          }),
        }),
      );
    });

    it("does NOT create an OverrideHistory row for a NORMAL transfer", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );

      await service.confirmTransfer("txn-1");

      expect(prisma.overrideHistory.create).not.toHaveBeenCalled();
    });

    it("marks FAILED and does not record spend when Rubies reports FAILED", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      prisma.transaction.findUniqueOrThrow.mockResolvedValue(
        pendingTransaction({ status: TransactionStatus.CONFIRMED }),
      );
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "FAILED",
        responseCode: "25",
      });

      await service.confirmTransfer("txn-1");

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransactionStatus.FAILED }),
        }),
      );
      expect(allowance.recordSpend).not.toHaveBeenCalled();
    });

    it("leaves the transaction CONFIRMED (not EXECUTED/FAILED) when Rubies reports PENDING, for the reconciliation job to resolve later", async () => {
      prisma.transaction.findUnique.mockResolvedValue(pendingTransaction());
      rubies.initiateTransfer.mockResolvedValue({
        reference: "REF-1",
        status: "PENDING",
        responseCode: "09",
      });

      await service.confirmTransfer("txn-1");

      // Only the one CONFIRMED update — no second update pushing it to EXECUTED/FAILED.
      expect(prisma.transaction.update).toHaveBeenCalledTimes(1);
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

      await service.cancelTransfer("txn-1");

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: TransactionStatus.CANCELLED },
        }),
      );
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
      await service.cancelTransfer("txn-1");
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });
  });

  describe("applyTransferResult", () => {
    it("is idempotent — a second call on an already-EXECUTED transaction is a no-op", async () => {
      prisma.transaction.findUniqueOrThrow.mockResolvedValue({
        id: "txn-1",
        status: TransactionStatus.EXECUTED,
        user,
        recipient,
        amount: 5000,
        type: TransactionType.NORMAL,
        feeAmount: 0,
      });

      await service.applyTransferResult("txn-1", "SUCCESS", "REF-1");

      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(allowance.recordSpend).not.toHaveBeenCalled();
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

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransactionStatus.EXECUTED }),
        }),
      );
      expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
    });
  });
});
