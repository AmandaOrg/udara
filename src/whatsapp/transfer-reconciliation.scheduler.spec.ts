import { TransferReconciliationScheduler } from "./transfer-reconciliation.scheduler";
import { TransactionStatus } from "@prisma/client";
import { BillPaymentStatus } from "../prisma/bill-payment.enums";

/**
 * These jobs are the only thing standing between "Rubies never told us what
 * happened" and a customer whose money moved but whose ledger says otherwise.
 * They had no test coverage at all.
 */
describe("TransferReconciliationScheduler", () => {
  let prisma: {
    transaction: { findMany: jest.Mock; count: jest.Mock };
    billPayment: { findMany: jest.Mock; count: jest.Mock };
  };
  let rubies: { queryTransferStatus: jest.Mock; queryVasTransaction: jest.Mock };
  let allowance: { recordSpend: jest.Mock; recordBillPaymentSpend: jest.Mock };
  let transferConfirmation: { applyTransferResult: jest.Mock };
  let billPaymentConfirmation: { applyBillPaymentResult: jest.Mock };
  let scheduler: TransferReconciliationScheduler;

  beforeEach(() => {
    prisma = {
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      billPayment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    rubies = {
      queryTransferStatus: jest.fn(),
      queryVasTransaction: jest.fn(),
    };
    allowance = {
      recordSpend: jest.fn().mockResolvedValue(undefined),
      recordBillPaymentSpend: jest.fn().mockResolvedValue(undefined),
    };
    transferConfirmation = {
      applyTransferResult: jest.fn().mockResolvedValue(undefined),
    };
    billPaymentConfirmation = {
      applyBillPaymentResult: jest.fn().mockResolvedValue(undefined),
    };

    scheduler = new TransferReconciliationScheduler(
      prisma as any,
      rubies as any,
      allowance as any,
      transferConfirmation as any,
      billPaymentConfirmation as any,
    );
  });

  describe("reconcileStuckTransfers", () => {
    const stuck = {
      id: "txn-1",
      idempotencyKey: "idem-1",
      status: TransactionStatus.CONFIRMED,
    };

    it("applies a resolved status back through the confirmation service", async () => {
      prisma.transaction.findMany.mockResolvedValue([stuck]);
      rubies.queryTransferStatus.mockResolvedValue({
        status: "SUCCESS",
        reference: "REF-1",
      });

      await scheduler.reconcileStuckTransfers();

      expect(transferConfirmation.applyTransferResult).toHaveBeenCalledWith(
        "txn-1",
        "SUCCESS",
        "REF-1",
      );
    });

    it("leaves a still-PENDING transfer alone for the next tick", async () => {
      prisma.transaction.findMany.mockResolvedValue([stuck]);
      rubies.queryTransferStatus.mockResolvedValue({ status: "PENDING" });

      await scheduler.reconcileStuckTransfers();

      expect(transferConfirmation.applyTransferResult).not.toHaveBeenCalled();
    });

    it("keeps going when one row's status query throws", async () => {
      prisma.transaction.findMany.mockResolvedValue([
        { ...stuck, id: "txn-1", idempotencyKey: "idem-1" },
        { ...stuck, id: "txn-2", idempotencyKey: "idem-2" },
      ]);
      rubies.queryTransferStatus
        .mockRejectedValueOnce(new Error("Rubies down"))
        .mockResolvedValueOnce({ status: "SUCCESS", reference: "REF-2" });

      await scheduler.reconcileStuckTransfers();

      expect(transferConfirmation.applyTransferResult).toHaveBeenCalledTimes(1);
      expect(transferConfirmation.applyTransferResult).toHaveBeenCalledWith(
        "txn-2",
        "SUCCESS",
        "REF-2",
      );
    });

    it("does not silently skip a row that can never be reconciled", async () => {
      prisma.transaction.findMany.mockResolvedValue([
        { ...stuck, idempotencyKey: null },
      ]);
      const logged = jest
        .spyOn((scheduler as any).logger, "error")
        .mockImplementation(() => undefined);

      await scheduler.reconcileStuckTransfers();

      expect(rubies.queryTransferStatus).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("no idempotencyKey"),
      );
    });

    it("bounds the batch and takes the oldest first, so nothing starves", async () => {
      await scheduler.reconcileStuckTransfers();

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 200,
          orderBy: { confirmedAt: "asc" },
        }),
      );
    });

    it("stops chasing rows past the give-up horizon", async () => {
      await scheduler.reconcileStuckTransfers();

      const where = prisma.transaction.findMany.mock.calls[0][0].where;
      expect(where.confirmedAt.gte).toBeInstanceOf(Date);
      expect(where.confirmedAt.lte).toBeInstanceOf(Date);
      expect(where.confirmedAt.gte.getTime()).toBeLessThan(
        where.confirmedAt.lte.getTime(),
      );
    });
  });

  describe("reconcileStuckBillPayments", () => {
    it("resolves a stuck purchase through the VAS transaction query", async () => {
      prisma.billPayment.findMany.mockResolvedValue([
        {
          id: "bill-1",
          requestReference: "UDARA-BILL-1",
          status: BillPaymentStatus.CONFIRMED,
        },
      ]);
      rubies.queryVasTransaction.mockResolvedValue({
        status: "SUCCESS",
        reference: "RUB-9",
        vendorToken: "1234-5678",
      });

      await scheduler.reconcileStuckBillPayments();

      expect(rubies.queryVasTransaction).toHaveBeenCalledWith("UDARA-BILL-1");
      expect(
        billPaymentConfirmation.applyBillPaymentResult,
      ).toHaveBeenCalledWith("bill-1", "SUCCESS", "RUB-9", "1234-5678");
    });

    it("falls back to the idempotency key when there is no request reference", async () => {
      prisma.billPayment.findMany.mockResolvedValue([
        { id: "bill-1", requestReference: null, idempotencyKey: "idem-b" },
      ]);
      rubies.queryVasTransaction.mockResolvedValue({ status: "PENDING" });

      await scheduler.reconcileStuckBillPayments();

      expect(rubies.queryVasTransaction).toHaveBeenCalledWith("idem-b");
      expect(
        billPaymentConfirmation.applyBillPaymentResult,
      ).not.toHaveBeenCalled();
    });
  });

  describe("repairUnappliedSpend", () => {
    /**
     * applyTransferResult writes the terminal status before running its side
     * effects, so a throw in between leaves money that moved with no allowance
     * recorded — permanently, until this job.
     */
    it("records spend for an executed transfer that never reached the allowance", async () => {
      prisma.transaction.findMany.mockResolvedValue([{ id: "txn-1" }]);

      await scheduler.repairUnappliedSpend();

      expect(allowance.recordSpend).toHaveBeenCalledWith("txn-1");
      const where = prisma.transaction.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        status: TransactionStatus.EXECUTED,
        appliedToAllowanceAt: null,
      });
    });

    it("records spend for an executed bill payment in the same state", async () => {
      prisma.billPayment.findMany.mockResolvedValue([{ id: "bill-1" }]);

      await scheduler.repairUnappliedSpend();

      expect(allowance.recordBillPaymentSpend).toHaveBeenCalledWith("bill-1");
    });

    it("keeps going when one repair throws", async () => {
      prisma.transaction.findMany.mockResolvedValue([
        { id: "txn-1" },
        { id: "txn-2" },
      ]);
      allowance.recordSpend.mockRejectedValueOnce(new Error("no allowance row"));

      await expect(scheduler.repairUnappliedSpend()).resolves.toBeUndefined();

      expect(allowance.recordSpend).toHaveBeenCalledTimes(2);
    });
  });

  describe("reportAbandonedWork", () => {
    it("says nothing when there is nothing abandoned", async () => {
      const logged = jest
        .spyOn((scheduler as any).logger, "error")
        .mockImplementation(() => undefined);

      await scheduler.reportAbandonedWork();

      expect(logged).not.toHaveBeenCalled();
    });

    it("reports work that is past the horizon and no longer retried", async () => {
      prisma.transaction.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
      prisma.billPayment.count.mockResolvedValue(3);
      const logged = jest
        .spyOn((scheduler as any).logger, "error")
        .mockImplementation(() => undefined);

      await scheduler.reportAbandonedWork();

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(
          "2 transfer(s), 3 bill payment(s), 1 executed transfer(s)",
        ),
      );
    });
  });
});
