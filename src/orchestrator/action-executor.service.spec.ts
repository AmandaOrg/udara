import { ActionExecutorService } from "./action-executor.service";
import { OnboardingStage } from "@prisma/client";

describe("ActionExecutorService", () => {
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let accountActions: Record<string, jest.Mock>;
  let spendSummary: {
    getWeeklySummary: jest.Mock;
    formatAsText: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock };
  let pinGate: { requestPinReset: jest.Mock };
  let billPaymentActions: {
    startAirtimeWizard: jest.Mock;
    startDataWizard: jest.Mock;
    startElectricityWizard: jest.Mock;
  };
  let executor: ActionExecutorService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: "0123456789",
  } as any;

  beforeEach(() => {
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    accountActions = {
      sendBalance: jest.fn().mockResolvedValue(undefined),
      sendLimitsStatus: jest.fn().mockResolvedValue(undefined),
      sendAccountDetails: jest.fn().mockResolvedValue(undefined),
      startTransferWizard: jest.fn().mockResolvedValue(undefined),
      resumePendingTransfer: jest.fn().mockResolvedValue(false),
      sendMainMenu: jest.fn().mockResolvedValue(undefined),
      applyHintsToDraft: jest.fn().mockResolvedValue(undefined),
      cancelActiveSurfaces: jest.fn().mockResolvedValue(undefined),
    };
    spendSummary = {
      getWeeklySummary: jest.fn().mockResolvedValue({}),
      formatAsText: jest.fn().mockReturnValue("summary"),
    };
    whatsapp = { sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }) };
    pinGate = { requestPinReset: jest.fn().mockResolvedValue(undefined) };
    billPaymentActions = {
      startAirtimeWizard: jest.fn().mockResolvedValue(undefined),
      startDataWizard: jest.fn().mockResolvedValue(undefined),
      startElectricityWizard: jest.fn().mockResolvedValue(undefined),
    };

    executor = new ActionExecutorService(
      chunkedMessenger as any,
      accountActions as any,
      billPaymentActions as any,
      spendSummary as any,
      whatsapp as any,
      pinGate as any,
    );
  });

  it("sends persona message then dispatches surface", async () => {
    await executor.execute(user, {
      message: "pulling your balance up",
      actionType: "show_surface",
      surfaceKey: "balance_read",
      ok: true,
    });

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      "234801",
      "pulling your balance up",
      "user-1",
    );
    expect(chunkedMessenger.sendChunkedReply).not.toHaveBeenCalled();
    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
  });

  it("does not let the LLM quote a balance in the lead-in", async () => {
    await executor.execute(user, {
      message: "pulling that up for you now, Esammy. account balance: ₦1,000",
      actionType: "show_surface",
      surfaceKey: "balance_read",
      ok: true,
    });

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      "234801",
      "pulling that up now.",
      "user-1",
    );
    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
  });

  it("passes sanitized transfer hints into startTransferWizard without session recovery", async () => {
    await executor.execute(user, {
      message: "lets send that",
      actionType: "show_surface",
      surfaceKey: "transfer_wizard",
      extractedHints: {
        amount: 15000,
        accountNumber: "0123456789",
        bankName: "GTBank",
        labelHint: "RENT",
      },
      ok: true,
    });

    expect(accountActions.startTransferWizard).toHaveBeenCalledWith(
      user,
      {
        amount: 15000,
        accountNumber: "0123456789",
        bankName: "GTBank",
        labelHint: "RENT",
      },
      { recoverFromSession: false },
    );
  });

  it("fill_wizard applies hints to the active draft", async () => {
    await executor.execute(user, {
      message: "got it",
      actionType: "fill_wizard",
      extractedHints: { amount: 800 },
      ok: true,
    });

    expect(accountActions.applyHintsToDraft).toHaveBeenCalledWith(user, {
      amount: 800,
    });
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it("cancel_surface cancels active wizard / pending confirm", async () => {
    await executor.execute(user, {
      message: "okay, dropping that",
      actionType: "cancel_surface",
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).toHaveBeenCalledWith(user);
  });

  it("on LLM failure shows the menu without miss copy", async () => {
    await executor.execute(user, { message: "", ok: false });

    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      "234801",
      "here's everything you can do with me.",
      "user-1",
    );
    expect(accountActions.sendMainMenu).toHaveBeenCalledWith(user);
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it("show_surface for a non-transfer surface cancels any active wizard first", async () => {
    await executor.execute(user, {
      message: "checking your limits",
      actionType: "show_surface",
      surfaceKey: "limits_read",
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).toHaveBeenCalledWith(user);
    expect(accountActions.sendLimitsStatus).toHaveBeenCalledWith(user);
  });

  it("show_surface transfer_wizard does not cancel first", async () => {
    await executor.execute(user, {
      message: "lets send that",
      actionType: "show_surface",
      surfaceKey: "transfer_wizard",
      ok: true,
    });

    expect(accountActions.cancelActiveSurfaces).not.toHaveBeenCalled();
    expect(accountActions.startTransferWizard).toHaveBeenCalled();
  });

  it("resumes pending confirm instead of starting a blank wizard", async () => {
    accountActions.resumePendingTransfer.mockResolvedValue(true);

    await executor.execute(user, {
      message: "i've pulled the details back up",
      actionType: "show_surface",
      surfaceKey: "transfer_wizard",
      ok: true,
    });

    expect(accountActions.resumePendingTransfer).toHaveBeenCalledWith(user);
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });
});
