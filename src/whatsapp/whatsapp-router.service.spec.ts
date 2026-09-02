import { WhatsappRouterService } from "./whatsapp-router.service";
import { OnboardingStage, WhatsappMessageType } from "@prisma/client";

/**
 * Post-onboarding free text always goes through Orchestrator + ActionExecutor.
 * Buttons / lists / flows stay deterministic.
 */
describe("WhatsappRouterService — orchestrator free text", () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  };
  let whatsapp: { sendText: jest.Mock; downloadMedia: jest.Mock };
  let onboarding: Record<string, jest.Mock>;
  let transferConfirmation: Record<string, jest.Mock>;
  let billPaymentActions: Record<string, jest.Mock>;
  let billPaymentConfirmation: Record<string, jest.Mock>;
  let accountActions: Record<string, jest.Mock>;
  let pinGate: { handlePinFlowReply: jest.Mock };
  let weeklyReview: {
    getReviewAwaitingLimit: jest.Mock;
    handleChoice: jest.Mock;
    handleLimitText: jest.Mock;
    abandonAwaitingLimit: jest.Mock;
  };
  let orchestrator: { handleMessage: jest.Mock };
  let actionExecutor: { execute: jest.Mock; sendSafeFallback: jest.Mock };
  let deepgram: { isConfigured: jest.Mock; transcribe: jest.Mock };
  let inboundMessages: { updateTextBody: jest.Mock };
  let service: WhatsappRouterService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
  };

  function makeMessage(textBody: string) {
    return {
      type: WhatsappMessageType.TEXT,
      fromNumber: "234801",
      textBody,
    } as any;
  }

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
        create: jest.fn().mockResolvedValue(user),
      },
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }),
      downloadMedia: jest.fn(),
    };
    onboarding = {
      handleInboundText: jest.fn(),
      handleInboundButton: jest.fn(),
      handleInboundFlowReply: jest.fn().mockResolvedValue(undefined),
    };
    transferConfirmation = {
      initiateTransfer: jest.fn(),
      executeVerifiedTransfer: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    billPaymentActions = {
      getActiveDraft: jest.fn().mockResolvedValue(null),
      handleWizardText: jest.fn().mockResolvedValue(undefined),
      handleAirtimeTelcoSelection: jest.fn().mockResolvedValue(undefined),
      handleDataTelcoSelection: jest.fn().mockResolvedValue(undefined),
      handleBundleSelection: jest.fn().mockResolvedValue(undefined),
      handleDiscoSelection: jest.fn().mockResolvedValue(undefined),
      startDataWizard: jest.fn().mockResolvedValue(undefined),
      startElectricityWizard: jest.fn().mockResolvedValue(undefined),
      startAirtimeWizard: jest.fn().mockResolvedValue(undefined),
      cancelDraft: jest.fn().mockResolvedValue(undefined),
    };
    billPaymentConfirmation = {
      confirmBillPayment: jest.fn().mockResolvedValue(undefined),
      cancelBillPayment: jest.fn().mockResolvedValue(undefined),
      executeVerifiedBillPayment: jest.fn().mockResolvedValue(undefined),
      resumeAfterPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    accountActions = {
      getActiveDraft: jest.fn().mockResolvedValue(null),
      sendBalance: jest.fn().mockResolvedValue(undefined),
      sendLimitsStatus: jest.fn().mockResolvedValue(undefined),
      sendAccountDetails: jest.fn().mockResolvedValue(undefined),
      startTransferWizard: jest.fn().mockResolvedValue(undefined),
      sendMainMenu: jest.fn().mockResolvedValue(undefined),
      handleWizardText: jest.fn().mockResolvedValue("handled"),
      handleWizardSelection: jest.fn().mockResolvedValue(undefined),
      applyHintsToDraft: jest.fn().mockResolvedValue(undefined),
      cancelActiveSurfaces: jest.fn().mockResolvedValue(undefined),
    };
    weeklyReview = {
      getReviewAwaitingLimit: jest.fn().mockResolvedValue(null),
      handleChoice: jest.fn().mockResolvedValue(undefined),
      handleLimitText: jest.fn().mockResolvedValue(undefined),
      abandonAwaitingLimit: jest.fn().mockResolvedValue(undefined),
    };
    pinGate = { handlePinFlowReply: jest.fn() };
    orchestrator = { handleMessage: jest.fn() };
    actionExecutor = {
      execute: jest.fn().mockResolvedValue(undefined),
      sendSafeFallback: jest.fn().mockResolvedValue(undefined),
    };

    deepgram = {
      isConfigured: jest.fn().mockReturnValue(false),
      transcribe: jest.fn(),
    };
    inboundMessages = {
      updateTextBody: jest.fn().mockResolvedValue(undefined),
    };

    service = new WhatsappRouterService(
      prisma as any,
      whatsapp as any,
      onboarding as any,
      transferConfirmation as any,
      billPaymentActions as any,
      billPaymentConfirmation as any,
      accountActions as any,
      pinGate as any,
      orchestrator as any,
      actionExecutor as any,
      weeklyReview as any,
      deepgram as any,
      inboundMessages as any,
    );
  });

  it("routes free text through orchestrator then action executor", async () => {
    const orchResult = {
      message: "pulling that up",
      actionType: "show_surface",
      surfaceKey: "balance_read",
      ok: true,
    };
    orchestrator.handleMessage.mockResolvedValue(orchResult);

    await service.route(makeMessage("hey what's my balance right now?"));

    expect(orchestrator.handleMessage).toHaveBeenCalledWith(
      user,
      "hey what's my balance right now?",
      {},
    );
    expect(actionExecutor.execute).toHaveBeenCalledWith(user, orchResult);
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
  });

  it("opens the menu immediately for 'what else can you do?' without the LLM", async () => {
    await service.route(makeMessage("what else can you do?"));

    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(accountActions.sendMainMenu).toHaveBeenCalledWith(user);
  });

  it("treats a menu row title pasted as text as a tap, not chat", async () => {
    await service.route(makeMessage("💰 Check balance"));

    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
  });

  it("acks 'great' after a completed send without dumping the menu", async () => {
    await service.route(makeMessage("Great"));

    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(accountActions.sendMainMenu).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(
      "234801",
      "glad that went through.",
      "user-1",
    );
  });

  it("still routes 'you already sent it' through the orchestrator", async () => {
    orchestrator.handleMessage.mockResolvedValue({
      message: "that one already went through.",
      actionType: "reply_only",
      ok: true,
    });

    await service.route(makeMessage("you've done the transfers already"));

    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalledWith(
      "234801",
      "glad that went through.",
      "user-1",
    );
  });

  it("routes balance paraphrases through the orchestrator (no regex shortcut)", async () => {
    orchestrator.handleMessage.mockResolvedValue({
      message: "pulling that up",
      actionType: "show_surface",
      surfaceKey: "balance_read",
      ok: true,
    });

    await service.route(makeMessage("how much do I have"));

    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
  });

  it("routes natural transfer phrasing through the orchestrator (no regex fast-path)", async () => {
    orchestrator.handleMessage.mockResolvedValue({
      message: "on it",
      actionType: "show_surface",
      surfaceKey: "transfer_wizard",
      extractedHints: {
        amount: 800,
        accountNumber: "8100368023",
        bankName: "opay",
      },
      ok: true,
    });

    await service.route(
      makeMessage("okay. lets make a transfer of 800 to 8100368023, opay"),
    );

    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
    expect(actionExecutor.execute).toHaveBeenCalled();
  });

  it("routes mid-wizard free text through the orchestrator (draft does not block)", async () => {
    accountActions.getActiveDraft.mockResolvedValue({ id: "draft-1" });
    orchestrator.handleMessage.mockResolvedValue({
      message: "got it",
      actionType: "fill_wizard",
      extractedHints: { amount: 800 },
      ok: true,
    });

    await service.route(makeMessage("800"));

    expect(accountActions.handleWizardText).not.toHaveBeenCalled();
    expect(orchestrator.handleMessage).toHaveBeenCalledWith(user, "800", {});
    expect(actionExecutor.execute).toHaveBeenCalled();
  });

  it("soft-fails through the executor when the orchestrator returns ok:false", async () => {
    orchestrator.handleMessage.mockResolvedValue({ ok: false, message: "" });

    await service.route(makeMessage("do i have my budget setup?"));

    expect(actionExecutor.execute).toHaveBeenCalledWith(user, {
      ok: false,
      message: "",
    });
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it("never reaches the orchestrator for a pre-account onboarding user", async () => {
    const onboardingUser = {
      ...user,
      onboardingStage: OnboardingStage.MONEY_STORY,
    };
    prisma.user.findUnique.mockResolvedValue(onboardingUser);
    prisma.user.update.mockResolvedValue(onboardingUser);

    await service.route(makeMessage("I'm trying to save for a car"));

    expect(onboarding.handleInboundText).toHaveBeenCalledWith(
      onboardingUser,
      "I'm trying to save for a car",
    );
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it("passes casual chat through orchestrator", async () => {
    orchestrator.handleMessage.mockResolvedValue({
      message: "I hear you — managers can look at that",
      actionType: "reply_only",
      ok: true,
    });

    await service.route(makeMessage("can you loosen my limits please"));

    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(actionExecutor.execute).toHaveBeenCalled();
  });

  describe("weekly review AWAITING_LIMIT", () => {
    const awaiting = { id: "wr-1", status: "AWAITING_LIMIT" };

    beforeEach(() => {
      weeklyReview.getReviewAwaitingLimit.mockResolvedValue(awaiting);
      orchestrator.handleMessage.mockResolvedValue({
        message: "hey",
        actionType: "reply_only",
        ok: true,
      });
    });

    it("sends a parseable amount to handleLimitText and does not orchestrate", async () => {
      await service.route(makeMessage("7000"));

      expect(weeklyReview.handleLimitText).toHaveBeenCalledWith(
        user,
        awaiting,
        "7000",
      );
      expect(weeklyReview.abandonAwaitingLimit).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });

    it("abandons silently on a greeting and continues to the orchestrator", async () => {
      await service.route(makeMessage("Hi"));

      expect(weeklyReview.handleLimitText).not.toHaveBeenCalled();
      expect(weeklyReview.abandonAwaitingLimit).toHaveBeenCalledWith(
        user,
        awaiting,
        { ack: false },
      );
      expect(orchestrator.handleMessage).toHaveBeenCalledWith(user, "Hi", {});
    });

    it("abandons silently on a balance question and continues to the orchestrator", async () => {
      await service.route(makeMessage("what's the balance"));

      expect(weeklyReview.handleLimitText).not.toHaveBeenCalled();
      expect(weeklyReview.abandonAwaitingLimit).toHaveBeenCalledWith(
        user,
        awaiting,
        { ack: false },
      );
      expect(orchestrator.handleMessage).toHaveBeenCalled();
    });

    it("acks cancel and does not orchestrate", async () => {
      await service.route(makeMessage("nevermind"));

      expect(weeklyReview.abandonAwaitingLimit).toHaveBeenCalledWith(
        user,
        awaiting,
        { ack: true },
      );
      expect(weeklyReview.handleLimitText).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe("PIN flow replies", () => {
    function flowMessage() {
      return {
        id: "m1",
        type: WhatsappMessageType.FLOW_REPLY,
        fromNumber: "234801",
        flowResponseJson: { flow_token: "tok-1", pin: "[redacted]" },
      } as any;
    }

    it("executes the transfer only when the gate authorizes it", async () => {
      pinGate.handlePinFlowReply.mockResolvedValue({
        action: "execute_transfer",
        transactionId: "txn-1",
      });

      await service.route(flowMessage(), { pin: "8317" });

      expect(transferConfirmation.executeVerifiedTransfer).toHaveBeenCalledWith(
        "txn-1",
      );
      expect(onboarding.handleInboundFlowReply).not.toHaveBeenCalled();
    });

    it("resumes the pending transfer after first-time PIN setup", async () => {
      pinGate.handlePinFlowReply.mockResolvedValue({
        action: "pin_setup_complete",
      });

      await service.route(flowMessage(), {
        pin: "8317",
        pin_confirm: "8317",
      });

      expect(transferConfirmation.resumeAfterPinSetup).toHaveBeenCalledWith(
        "user-1",
      );
      expect(
        transferConfirmation.executeVerifiedTransfer,
      ).not.toHaveBeenCalled();
    });
  });

  describe("audio and images", () => {
    it("asks the user to type when Deepgram is not configured", async () => {
      await service.route({
        id: "m-audio",
        type: WhatsappMessageType.AUDIO,
        fromNumber: "234801",
        mediaId: "media-1",
      } as any);

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringMatching(/type that instead/i),
        "user-1",
      );
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });

    it("transcribes a voice note and routes it like text", async () => {
      deepgram.isConfigured.mockReturnValue(true);
      whatsapp.downloadMedia.mockResolvedValue({
        buffer: Buffer.from("ogg"),
        mimeType: "audio/ogg",
      });
      deepgram.transcribe.mockResolvedValue({
        ok: true,
        text: "what's my balance",
      });
      orchestrator.handleMessage.mockResolvedValue({
        message: "pulling that up",
        actionType: "reply_only",
        ok: true,
      });

      await service.route({
        id: "m-audio",
        type: WhatsappMessageType.AUDIO,
        fromNumber: "234801",
        mediaId: "media-1",
      } as any);

      expect(inboundMessages.updateTextBody).toHaveBeenCalledWith(
        "m-audio",
        "what's my balance",
      );
      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        user,
        "what's my balance",
        {},
      );
    });

    it("passes a downloaded image into the orchestrator", async () => {
      whatsapp.downloadMedia.mockResolvedValue({
        buffer: Buffer.from("jpeg-bytes"),
        mimeType: "image/jpeg",
      });
      orchestrator.handleMessage.mockResolvedValue({
        message: "got it",
        actionType: "reply_only",
        ok: true,
      });

      await service.route({
        id: "m-img",
        type: WhatsappMessageType.IMAGE,
        fromNumber: "234801",
        mediaId: "img-1",
        textBody: "this receipt",
      } as any);

      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        user,
        "this receipt",
        {
          image: {
            mimeType: "image/jpeg",
            data: Buffer.from("jpeg-bytes").toString("base64"),
          },
        },
      );
    });
  });
});
