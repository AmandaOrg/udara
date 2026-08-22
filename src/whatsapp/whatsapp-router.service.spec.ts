import { WhatsappRouterService } from "./whatsapp-router.service";
import { OnboardingStage, WhatsappMessageType } from "@prisma/client";

/**
 * Focused on the classify-before-chat step (IntentRouterService): free text
 * that doesn't match one of the fast keyword/regex shortcuts but whose
 * intent is one of the four menu actions must reach the real deterministic
 * handler, not KeduChatService's ungrounded persona chat. A NONE
 * classification must still fall through to chat exactly as before.
 */
describe("WhatsappRouterService — intent-classified free text", () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  };
  let whatsapp: { sendText: jest.Mock };
  let onboarding: Record<string, jest.Mock>;
  let spendSummary: Record<string, jest.Mock>;
  let transferConfirmation: Record<string, jest.Mock>;
  let managerConversation: Record<string, jest.Mock>;
  let keduChat: { handleMessage: jest.Mock };
  let accountActions: Record<string, jest.Mock>;
  let intentRouter: { classify: jest.Mock };
  let service: WhatsappRouterService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED, // post-onboarding, so the classify step is reachable
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
    };
    spendSummary = {
      getWeeklySummary: jest.fn(),
      formatAsText: jest.fn(),
    };
    transferConfirmation = { initiateTransfer: jest.fn() };
    managerConversation = { fileChangeRequest: jest.fn() };
    keduChat = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    accountActions = {
      getActiveDraft: jest.fn().mockResolvedValue(null),
      sendBalance: jest.fn().mockResolvedValue(undefined),
      sendLimitsStatus: jest.fn().mockResolvedValue(undefined),
      sendAccountDetails: jest.fn().mockResolvedValue(undefined),
      startTransferWizard: jest.fn().mockResolvedValue(undefined),
      sendMainMenu: jest.fn().mockResolvedValue(undefined),
    };
    intentRouter = { classify: jest.fn() };

    service = new WhatsappRouterService(
      prisma as any,
      whatsapp as any,
      onboarding as any,
      spendSummary as any,
      transferConfirmation as any,
      managerConversation as any,
      keduChat as any,
      accountActions as any,
      intentRouter as any,
    );
  });

  it("routes a naturally-phrased balance question to the real balance handler, not chat", async () => {
    intentRouter.classify.mockResolvedValue("BALANCE");

    await service.route(makeMessage("hey what's my balance right now?"));

    expect(intentRouter.classify).toHaveBeenCalledWith(
      "hey what's my balance right now?",
      "user-1",
    );
    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
    expect(keduChat.handleMessage).not.toHaveBeenCalled();
  });

  it("routes a naturally-phrased limits question to the real limits handler, not chat", async () => {
    intentRouter.classify.mockResolvedValue("LIMITS");

    await service.route(makeMessage("what's my daily limit status right now"));

    expect(accountActions.sendLimitsStatus).toHaveBeenCalledWith(user);
    expect(keduChat.handleMessage).not.toHaveBeenCalled();
  });

  it("routes a naturally-phrased account-details question to the real handler, not chat", async () => {
    intentRouter.classify.mockResolvedValue("ACCOUNT_DETAILS");

    await service.route(makeMessage("what's my account number again"));

    expect(accountActions.sendAccountDetails).toHaveBeenCalledWith(user);
    expect(keduChat.handleMessage).not.toHaveBeenCalled();
  });

  it("starts the guided transfer wizard for free-text transfer intent, never attempting to parse the details itself", async () => {
    intentRouter.classify.mockResolvedValue("TRANSFER");

    await service.route(makeMessage("I want to send my landlord some money"));

    expect(accountActions.startTransferWizard).toHaveBeenCalledWith(user);
    expect(transferConfirmation.initiateTransfer).not.toHaveBeenCalled();
    expect(keduChat.handleMessage).not.toHaveBeenCalled();
  });

  it("still falls through to KeduChatService when the classifier returns NONE", async () => {
    intentRouter.classify.mockResolvedValue("NONE");

    await service.route(makeMessage("lol you're funny"));

    expect(keduChat.handleMessage).toHaveBeenCalledWith(
      user,
      "lol you're funny",
    );
    expect(accountActions.sendBalance).not.toHaveBeenCalled();
    expect(accountActions.startTransferWizard).not.toHaveBeenCalled();
  });

  it("never reaches the classifier for an exact keyword shortcut (fast path stays fast)", async () => {
    await service.route(makeMessage("balance"));

    expect(accountActions.sendBalance).toHaveBeenCalledWith(user);
    expect(intentRouter.classify).not.toHaveBeenCalled();
  });

  it("never reaches the classifier while an in-progress transfer-wizard draft owns the next message", async () => {
    accountActions.getActiveDraft.mockResolvedValue({ id: "draft-1" });
    accountActions.handleWizardText = jest.fn().mockResolvedValue(undefined);

    await service.route(makeMessage("50000"));

    expect(accountActions.handleWizardText).toHaveBeenCalledWith(
      user,
      "draft-1",
      "50000",
    );
    expect(intentRouter.classify).not.toHaveBeenCalled();
  });

  it("never reaches the classifier for a pre-account (onboarding) user — onboarding is unaffected", async () => {
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
    expect(intentRouter.classify).not.toHaveBeenCalled();
    expect(keduChat.handleMessage).not.toHaveBeenCalled();
  });

  it("a settings-change request that isn't the exact manager command falls through to chat, same as before — the classifier must not intercept it", async () => {
    intentRouter.classify.mockResolvedValue("NONE");

    await service.route(makeMessage("can you loosen my limits please"));

    expect(managerConversation.fileChangeRequest).not.toHaveBeenCalled();
    expect(accountActions.sendLimitsStatus).not.toHaveBeenCalled();
    expect(keduChat.handleMessage).toHaveBeenCalledWith(
      user,
      "can you loosen my limits please",
    );
  });
});
