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
  let managerConversation: { fileChangeRequest: jest.Mock };
  let billPaymentActions: {
    startAirtimeWizard: jest.Mock;
    startDataWizard: jest.Mock;
    startElectricityWizard: jest.Mock;
    applyHintsToDraft: jest.Mock;
    cancelActiveDraftForUser: jest.Mock;
    getActiveDraft: jest.Mock;
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
    managerConversation = {
      fileChangeRequest: jest.fn().mockResolvedValue({ id: "req-1" }),
    };
    billPaymentActions = {
      startAirtimeWizard: jest.fn().mockResolvedValue(undefined),
      startDataWizard: jest.fn().mockResolvedValue(undefined),
      startElectricityWizard: jest.fn().mockResolvedValue(undefined),
      applyHintsToDraft: jest.fn().mockResolvedValue(undefined),
      cancelActiveDraftForUser: jest.fn().mockResolvedValue(undefined),
      getActiveDraft: jest.fn().mockResolvedValue(null),
    };

    executor = new ActionExecutorService(
      chunkedMessenger as any,
      accountActions as any,
      billPaymentActions as any,
      spendSummary as any,
      whatsapp as any,
      pinGate as any,
      managerConversation as any,
    );
  });

  it("does not send an LLM lead-in before a read surface", async () => {
    await executor.execute(user, {
      message: "hey Esammy, still here. what's on your mind?",
      actionType: "show_surface",
      surfaceKey: "balance_read",
      ok: true,
    });

    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(chunkedMessenger.sendChunkedReply).not.toHaveBeenCalled();
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

  it("passes hints into startAirtimeWizard", async () => {
    await executor.execute(user, {
      message: "on it.",
      actionType: "show_surface",
      surfaceKey: "bill_payment_wizard",
      extractedHints: { amount: 2000, telcoHint: "mtn" },
      ok: true,
    });

    expect(billPaymentActions.startAirtimeWizard).toHaveBeenCalledWith(user, {
      amount: 2000,
      telcoHint: "mtn",
    });
  });

  it("fill_wizard applies bill hints when a bill draft is active", async () => {
    billPaymentActions.getActiveDraft.mockResolvedValue({ id: "bill-1" });

    await executor.execute(user, {
      message: "got it",
      actionType: "fill_wizard",
      extractedHints: { amount: 2000 },
      ok: true,
    });

    expect(billPaymentActions.applyHintsToDraft).toHaveBeenCalledWith(user, {
      amount: 2000,
    });
    expect(accountActions.applyHintsToDraft).not.toHaveBeenCalled();
  });

  it("fill_wizard applies hints to the active transfer draft", async () => {
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

  /**
   * ADR-0001. The terms promise this path and nothing could reach it: the
   * manager module's entry points had no caller outside their own directory.
   */
  describe("settings_request", () => {
    it("files a request with the type the model identified", async () => {
      await executor.execute(
        user as any,
        {
          message: "i'll pass that to the managers",
          actionType: "show_surface",
          surfaceKey: "settings_request",
          extractedHints: {
            settingsChangeType: "EXIT_RESTRICTIONS",
            settingsReason: "i want to stop using udara",
          },
          ok: true,
        } as any,
      );

      expect(managerConversation.fileChangeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          type: "EXIT_RESTRICTIONS",
          reason: "i want to stop using udara",
        }),
      );
    });

    it("falls back to OTHER rather than guessing which rule they meant", async () => {
      await executor.execute(
        user as any,
        {
          message: "noted",
          actionType: "show_surface",
          surfaceKey: "settings_request",
          extractedHints: {},
          ok: true,
        } as any,
      );

      expect(managerConversation.fileChangeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: "OTHER" }),
      );
    });
  });
});
