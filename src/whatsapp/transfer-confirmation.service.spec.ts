import {
  TransferConfirmationService,
  CONFIRM_BUTTON_PREFIX,
  CANCEL_BUTTON_PREFIX,
} from "./transfer-confirmation.service";
import {
  OnboardingStage,
  RecipientLabel,
  TransactionStatus,
} from "@prisma/client";
import { TransactionType } from "../common/enums/transaction-type.enum";

describe("TransferConfirmationService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    transaction: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    overrideHistory: { create: jest.Mock };
    dailyAllowance: { findMany: jest.Mock };
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
  let tagging: { findRecipient: jest.Mock; tagRecipient: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendInteractiveButtons: jest.Mock };
  let config: { get: jest.Mock };
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
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      transaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      overrideHistory: { create: jest.fn() },
      dailyAllowance: { findMany: jest.fn().mockResolvedValue([]) },
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

    service = new TransferConfirmationService(
      prisma as any,
      config as any,
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
        expect.stringContaining("don't have a Udara account"),
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
        expect(prisma.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              feeSweepReference: "FEE-REF-1",
              feeSweptAt: expect.any(Date),
            }),
          }),
        );
      });

      it("records the reference but not feeSweptAt when the sweep itself comes back PENDING", async () => {
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

        expect(prisma.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              feeSweepReference: "FEE-REF-2",
              feeSweptAt: undefined,
            }),
          }),
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
