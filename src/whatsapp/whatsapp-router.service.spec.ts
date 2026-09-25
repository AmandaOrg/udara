import { WhatsappRouterService } from "./whatsapp-router.service";
import { PinOutcomeService } from "./pin-outcome.service";
import { OnboardingStage, Prisma, WhatsappMessageType } from "@prisma/client";
import { whatsappTestMessenger } from "../messaging/testing/whatsapp-test-messenger";

/**
 * Post-onboarding free text always goes through Orchestrator + ActionExecutor.
 * Buttons / lists / flows stay deterministic.
 */
describe("WhatsappRouterService — orchestrator free text", () => {
  let prisma: {
    user: {
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
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
    handleLimitAmount: jest.Mock;
    abandonAwaitingLimit: jest.Mock;
  };
  let orchestrator: { handleMessage: jest.Mock };
  let actionExecutor: { execute: jest.Mock; sendSafeFallback: jest.Mock };
  let deepgram: { isConfigured: jest.Mock; transcribe: jest.Mock };
  let inboundMessages: { updateTextBody: jest.Mock; attachUser: jest.Mock };
  let rateLimit: { check: jest.Mock };
  let loginApproval: { decide: jest.Mock };
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
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      handleLimitAmount: jest.fn().mockResolvedValue(undefined),
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
      attachUser: jest.fn().mockResolvedValue(undefined),
    };
    loginApproval = { decide: jest.fn().mockResolvedValue(undefined) };
    // Under the limit by default; the throttling tests override it.
    rateLimit = {
      check: jest
        .fn()
        .mockResolvedValue({ limited: false, justCrossed: false }),
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
      rateLimit as any,
      // Real, over the mocks below, so the PIN tests still assert what runs.
      new PinOutcomeService(
        transferConfirmation as any,
        billPaymentConfirmation as any,
      ),
      whatsappTestMessenger({ whatsapp }),
      loginApproval as any,
    );
  });

  describe("who the sender is", () => {
    const hello = {
      id: "m1",
      type: WhatsappMessageType.TEXT,
      textBody: "hello",
      fromNumber: "234801",
    } as any;

    beforeEach(() => {
      orchestrator.handleMessage.mockResolvedValue({ message: "hi" });
    });

    it("finds a returning WhatsApp user by their number and records the message time", async () => {
      await service.route(hello);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { whatsappNumber: "234801" },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { lastInboundMessageAt: expect.any(Date) },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("creates a new number as a user whose phone number is the WhatsApp id", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await service.route(hello);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          phoneNumber: "234801",
          whatsappNumber: "234801",
          lastInboundMessageAt: expect.any(Date),
        },
      });
    });

    /**
     * Someone who signed up in the app and then messages on WhatsApp is one
     * person with one set of limits, not a second account.
     */
    it("links the first WhatsApp message to the account that already has that phone number", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(user);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await service.route(hello);

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { phoneNumber: "234801", whatsappNumber: null },
        data: {
          whatsappNumber: "234801",
          lastInboundMessageAt: expect.any(Date),
        },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        user,
        "hello",
        expect.anything(),
      );
    });

    it("uses the row a racing request created instead of failing", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(user);
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "5.22.0",
        }),
      );

      await service.route(hello);

      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        user,
        "hello",
        expect.anything(),
      );
    });
  });

  describe("inbound rate limit", () => {
    /**
     * The cap counts inbound rows by userId, but the row is persisted before
     * the sender is known. Until the router linked it, every count was zero
     * and the limit could never trip.
     */
    it("links the inbound row to the user before counting", async () => {
      const order: string[] = [];
      inboundMessages.attachUser.mockImplementation(async () => {
        order.push("attach");
      });
      rateLimit.check.mockImplementation(async () => {
        order.push("check");
        return { limited: false, justCrossed: false };
      });
      orchestrator.handleMessage.mockResolvedValue({ message: "hi" });

      await service.route({
        id: "m1",
        type: "TEXT",
        textBody: "hello",
        fromNumber: "234801",
      } as any);

      expect(inboundMessages.attachUser).toHaveBeenCalledWith("m1", "user-1");
      expect(order).toEqual(["attach", "check"]);
    });

    it("drops the message before any handler once the user is over the limit", async () => {
      rateLimit.check.mockResolvedValue({ limited: true, justCrossed: false });

      await service.route({
        id: "m1",
        type: "TEXT",
        textBody: "hello",
        fromNumber: "234801",
      } as any);

      // Nothing that costs money runs: no LLM, no onboarding turn, no reply.
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
      expect(onboarding.handleInboundText).not.toHaveBeenCalled();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it("says why, exactly once, on the message that crosses the line", async () => {
      rateLimit.check.mockResolvedValue({ limited: true, justCrossed: true });

      await service.route({
        id: "m1",
        type: "TEXT",
        textBody: "hello",
        fromNumber: "234801",
      } as any);

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("a lot of messages"),
        expect.any(String),
      );
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });
  });

  describe("app sign-in approval buttons", () => {
    it.each([
      ["login_approve:challenge-9", true],
      ["login_deny:challenge-9", false],
    ])(
      "hands %s to the approval service for the tapping user",
      async (payload, approve) => {
        await service.route({
          id: "m1",
          type: WhatsappMessageType.BUTTON_REPLY,
          fromNumber: "234801",
          buttonPayload: payload,
        } as any);

        expect(loginApproval.decide).toHaveBeenCalledWith(
          user,
          "challenge-9",
          approve,
        );
      },
    );

    it("answers them even for a user still in onboarding", async () => {
      // The router works with the row findOrCreateUser's update returns.
      prisma.user.update.mockResolvedValueOnce({
        ...user,
        onboardingStage: OnboardingStage.IDENTITY,
      });

      await service.route({
        id: "m1",
        type: WhatsappMessageType.BUTTON_REPLY,
        fromNumber: "234801",
        buttonPayload: "login_approve:challenge-9",
      } as any);

      expect(loginApproval.decide).toHaveBeenCalled();
      expect(onboarding.handleInboundButton).not.toHaveBeenCalled();
    });
  });

  describe("confirm and cancel buttons", () => {
    function buttonMessage(buttonPayload: string) {
      return {
        id: "m1",
        type: WhatsappMessageType.BUTTON_REPLY,
        fromNumber: "234801",
        buttonPayload,
      } as any;
    }

    /**
     * The id inside the payload is scoped to whoever tapped it, so a payload
     * naming someone else's transaction reads as "not found" downstream.
     */
    it("passes the sender's own user id alongside the id in the payload", async () => {
      transferConfirmation.confirmTransfer = jest.fn();
      transferConfirmation.cancelTransfer = jest.fn();

      await service.route(buttonMessage("confirm_transfer:txn-9"));
      await service.route(buttonMessage("cancel_transfer:txn-9"));
      await service.route(buttonMessage("confirm_bill:bill-9"));
      await service.route(buttonMessage("cancel_bill:bill-9"));

      expect(transferConfirmation.confirmTransfer).toHaveBeenCalledWith(
        "user-1",
        "txn-9",
      );
      expect(transferConfirmation.cancelTransfer).toHaveBeenCalledWith(
        "user-1",
        "txn-9",
      );
      expect(billPaymentConfirmation.confirmBillPayment).toHaveBeenCalledWith(
        "user-1",
        "bill-9",
      );
      expect(billPaymentConfirmation.cancelBillPayment).toHaveBeenCalledWith(
        "user-1",
        "bill-9",
      );
    });
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

    it.each([
      "7000",
      "7000 naira",
      "make it 7k",
      "7000 a day",
      "Seven thousand.",
    ])("reads %p as the answer it plainly is", async (answer) => {
      await service.route(makeMessage(answer));

      expect(weeklyReview.handleLimitAmount).toHaveBeenCalledWith(
        user,
        awaiting,
        7000,
      );
      expect(weeklyReview.abandonAwaitingLimit).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });

    /**
     * The wait is still dropped for anything that is not an answer — otherwise
     * the review traps ordinary chat — but the user is told, which is the part
     * that was missing.
     */
    it.each(["Hi", "what's the balance"])(
      "tells the user before dropping the wait on %p, then carries on",
      async (message) => {
        await service.route(makeMessage(message));

        expect(weeklyReview.handleLimitAmount).not.toHaveBeenCalled();
        expect(weeklyReview.abandonAwaitingLimit).toHaveBeenCalledWith(
          user,
          awaiting,
        );
        expect(orchestrator.handleMessage).toHaveBeenCalled();
      },
    );

    it("acks cancel and does not orchestrate", async () => {
      await service.route(makeMessage("nevermind"));

      expect(weeklyReview.abandonAwaitingLimit).toHaveBeenCalledWith(
        user,
        awaiting,
      );
      expect(weeklyReview.handleLimitAmount).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    });

    it("does not claim something went through after dropping the wait", async () => {
      // "thanks" is a short completion ack, so the old code dropped the review
      // silently and then said "glad that went through." — a claim of success
      // for the thing it had just discarded.
      await service.route(makeMessage("thanks"));

      expect(whatsapp.sendText).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("went through"),
        expect.anything(),
      );
    });

    it("lets an active bill wizard have its own amount and its own cancel", async () => {
      // The review branch used to run first, so "500" for an airtime purchase
      // was rejected as too low a daily limit and "cancel" acked the review
      // while the wizard stayed live to swallow the next number typed.
      billPaymentActions.getActiveDraft.mockResolvedValue({
        id: "bill-1",
        step: "AWAITING_AMOUNT",
      });

      await service.route(makeMessage("500"));
      expect(billPaymentActions.handleWizardText).toHaveBeenCalled();
      expect(weeklyReview.handleLimitAmount).not.toHaveBeenCalled();

      await service.route(makeMessage("cancel"));
      expect(billPaymentActions.cancelDraft).toHaveBeenCalled();
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
          // A captioned photo is real user text, so it is not synthetic.
          syntheticText: false,
        },
      );
    });

    /**
     * A captionless photo arrives as the literal "(user sent a photo)", which
     * is not an answer to anything — but it is not an amount either, so it used
     * to close an open weekly-limit wait silently on its way past.
     */
    it("does not let a captionless photo answer the weekly-limit question", async () => {
      weeklyReview.getReviewAwaitingLimit.mockResolvedValue({ id: "wr-1" });
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
        textBody: "",
      } as any);

      expect(weeklyReview.getReviewAwaitingLimit).not.toHaveBeenCalled();
      expect(weeklyReview.abandonAwaitingLimit).not.toHaveBeenCalled();
    });
  });
});
