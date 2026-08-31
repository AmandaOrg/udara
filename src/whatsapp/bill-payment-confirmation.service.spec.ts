import {
  BillPaymentCategory,
  BillPaymentStatus,
} from "../prisma/bill-payment.enums";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { TransactionType } from "../common/enums/transaction-type.enum";

describe("BillPaymentConfirmationService", () => {
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    billPayment: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
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
        update: jest.fn().mockResolvedValue(undefined),
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
      whatsapp as never,
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
    expect(prisma.billPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vendorToken: "1234-5678-9012" }),
      }),
    );
  });
});
