import { Logger } from "@nestjs/common";
import { OnboardingStage } from "@prisma/client";
import { Sentry } from "../common/sentry";
import { RubiesWebhookController } from "./rubies-webhook.controller";

/**
 * Money arriving. Only the account-closure path is covered here (ADR-0003);
 * the rest of this controller is exercised end to end by the e2e scenarios.
 */
describe("RubiesWebhookController: incoming credits", () => {
  const payload = {
    creditAccount: "3312345678",
    paymentReference: "RUB-REF-1",
    amount: "2500",
    narration: "salary",
    originatorName: "Some Sender",
  };
  let prisma: any;
  let messenger: { sendText: jest.Mock };
  let email: { sendMoneyIn: jest.Mock };
  let allowance: { getOrCreateTodayAllowance: jest.Mock };
  let controller: RubiesWebhookController;
  let capture: jest.SpyInstance;
  let error: jest.SpyInstance;

  const credit = (user: Record<string, unknown>) => {
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      name: "Ada",
      onboardingStage: OnboardingStage.COMPLETE,
      closedAt: null,
      ...user,
    });
    return (controller as any).handleIncomingCredit(payload);
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      incomingCredit: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    messenger = { sendText: jest.fn().mockResolvedValue(undefined) };
    email = { sendMoneyIn: jest.fn().mockResolvedValue(undefined) };
    allowance = { getOrCreateTodayAllowance: jest.fn() };
    controller = new RubiesWebhookController(
      prisma,
      messenger as any,
      {} as any,
      {} as any,
      {} as any,
      allowance as any,
      email as any,
    );
    capture = jest.spyOn(Sentry, "captureMessage").mockReturnValue("");
    error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    capture.mockRestore();
    error.mockRestore();
  });

  it("tells an open account about the money, by message and email", async () => {
    await credit({});

    expect(prisma.incomingCredit.create).toHaveBeenCalled();
    expect(email.sendMoneyIn).toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps a credit to a closed account as a record, messages nobody, and pages ops by reference", async () => {
    await credit({ closedAt: new Date("2026-10-01T00:00:00Z") });

    expect(prisma.incomingCredit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        rubiesReference: "RUB-REF-1",
      }),
    });
    expect(messenger.sendText).not.toHaveBeenCalled();
    expect(email.sendMoneyIn).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();

    expect(capture).toHaveBeenCalledWith(
      expect.stringContaining("RUB-REF-1"),
      "error",
    );
    // The account number is the counterparty's PII: never in the alert.
    expect(capture.mock.calls[0][0]).not.toContain(payload.creditAccount);
  });
});
