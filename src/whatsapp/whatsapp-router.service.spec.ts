import { WhatsappRouterService } from "./whatsapp-router.service";
import { OnboardingStage, WhatsappMessageType } from "@prisma/client";

/**
 * Free-text fallthrough goes through Orchestrator + ActionExecutor.
 * Exact keyword shortcuts and wizard drafts stay deterministic.
 */
describe("WhatsappRouterService — orchestrator free text", () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  };
  let whatsapp: { sendText: jest.Mock };
  let onboarding: Record<string, jest.Mock>;
  let spendSummary: Record<string, jest.Mock>;
  let transferConfirmation: Record<string, jest.Mock>;
  let managerConversation: Record<string, jest.Mock>;
  let accountActions: Record<string, jest.Mock>;
  let pinGate: { handlePinFlowReply: jest.Mock };
  let orchestrator: { handleMessage: jest.Mock };
  let actionExecutor: { execute: jest.Mock };
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
    whatsapp = { sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }) };
    onboarding = {
      handleInboundText: jest.fn(),
      handleInboundButton: jest.fn(),
      handleInboundFlowReply: jest.fn().mockResolvedValue(undefined),
    };
    spendSummary = {
      getWeeklySummary: jest.fn(),
      formatAsText: jest.fn(),
    };
    transferConfirmation = {
      initiateTransfer: jest.fn(),
      executeVerifiedTransfer: jest.fn().mockResolvedValue(undefined),
    };
    managerConversation = { fileChangeRequest: jest.fn() };
    accountActions = {
      getActiveDraft: jest.fn().mockResolvedValue(null),
      sendBalance: jest.fn().mockResolvedValue(undefined),
      sendLimitsStatus: jest.fn().mockResolvedValue(undefined),
      sendAccountDetails: jest.fn().mockResolvedValue(undefined),
      startTransferWizard: jest.fn().mockResolvedValue(undefined),
      sendMainMenu: jest.fn().mockResolvedValue(undefined),
      handleWizardText: jest.fn().mockResolvedValue(undefined),
    };
    pinGate = { handlePinFlowReply: jest.fn() };
    orchestrator = { handleMessage: jest.fn() };
    actionExecutor = { execute: jest.fn().mockResolvedValue(undefined) };

    service = new WhatsappRouterService(
      prisma as any,
      whatsapp as any,
      onboarding as any,
      spendSummary as any,
      transferConfirmation as any,
      managerConversation as any,
      accountActions as any,
      pinGate as any,
      orchestrator as any,
      actionExecutor as any,
    );
  });

  it("routes free text through orchestrator then action executor", async () => {
    const orchResult = {
      message: "pulling that up",
      surfaceKey: "balance_read",
      ok: true,
    };
    orchestrator.handleMessage.mockResolvedValue(orchResult);

    await service.route(makeMessage("hey what's my balance right now?"));

    expect(orchestrator.handleMessage).toHaveBeenCalledWith(
      user,
      "hey what's my balance right now?",
    );
    expect(actionExecutor.execute).toHaveBeenCalledWith(user, orchResult);
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
  });

  it("never reaches the orchestrator for an exact keyword shortcut", async () => {
    await service.route(makeMessage("balance"));

    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it("never reaches the orchestrator while an active transfer draft owns the turn", async () => {
    accountActions.getActiveDraft.mockResolvedValue({ id: "draft-1" });

    await service.route(makeMessage("50000"));

    expect(accountActions.handleWizardText).toHaveBeenCalledWith(
      user,
      "draft-1",
      "50000",
    );
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
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

  it("passes casual chat through orchestrator (settings talk is not intercepted by shortcuts)", async () => {
    orchestrator.handleMessage.mockResolvedValue({
      message: "I hear you — managers can look at that",
      ok: true,
    });

    await service.route(makeMessage("can you loosen my limits please"));

    expect(managerConversation.fileChangeRequest).not.toHaveBeenCalled();
    expect(accountActions.sendLimitsStatus).not.toHaveBeenCalled();
    expect(orchestrator.handleMessage).toHaveBeenCalled();
    expect(actionExecutor.execute).toHaveBeenCalled();
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

    it("does not execute anything when the gate declines", async () => {
      pinGate.handlePinFlowReply.mockResolvedValue({ action: "none" });

      await service.route(flowMessage(), { pin: "0000" });

      expect(
        transferConfirmation.executeVerifiedTransfer,
      ).not.toHaveBeenCalled();
    });

    it("passes the in-memory PIN to the gate, not the redacted persisted value", async () => {
      pinGate.handlePinFlowReply.mockResolvedValue({ action: "none" });

      await service.route(flowMessage(), { pin: "8317" });

      expect(pinGate.handlePinFlowReply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ flow_token: "tok-1" }),
        { pin: "8317" },
      );
    });

    it("routes a KYC submission to onboarding, not the PIN gate", async () => {
      const kycUser = { ...user, onboardingStage: "PLAN_PROPOSED" };
      prisma.user.findUnique.mockResolvedValue(kycUser);
      prisma.user.update.mockResolvedValue(kycUser);

      await service.route(
        {
          id: "m2",
          type: WhatsappMessageType.FLOW_REPLY,
          fromNumber: "234801",
          flowResponseJson: { flow_token: "tok-2", first_name: "Daniel" },
        } as any,
        { id_number: "12345678901" },
      );

      expect(pinGate.handlePinFlowReply).not.toHaveBeenCalled();
      expect(onboarding.handleInboundFlowReply).toHaveBeenCalled();
    });
  });
});
