import { Logger } from "@nestjs/common";
import { OnboardingStage } from "@prisma/client";
import { ConversationRouterService } from "./conversation-router.service";

/**
 * Routing order and every button prefix are covered through WhatsApp input in
 * whatsapp-router.service.spec.ts, which predates this extraction. This covers
 * what the extraction added: the form entry points, and holding onboarding
 * until an app-only user has a PIN.
 */
describe("ConversationRouterService", () => {
  let onboarding: Record<string, jest.Mock>;
  let pinGate: { handlePinFlowReply: jest.Mock; requestPinSetup: jest.Mock };
  let pinOutcome: { apply: jest.Mock };
  let orchestrator: { handleMessage: jest.Mock };
  let messenger: { sendText: jest.Mock };
  let service: ConversationRouterService;

  const onboardingUser = {
    id: "user-1",
    whatsappNumber: null,
    onboardingStage: OnboardingStage.MONEY_STORY,
  } as any;

  beforeEach(() => {
    onboarding = {
      handleInboundText: jest.fn().mockResolvedValue(undefined),
      handleInboundButton: jest.fn().mockResolvedValue(undefined),
      handleInboundFlowReply: jest.fn().mockResolvedValue(undefined),
      isAwaitingPinSetup: jest.fn().mockResolvedValue(false),
    };
    pinGate = {
      handlePinFlowReply: jest.fn().mockResolvedValue({ action: "none" }),
      requestPinSetup: jest.fn().mockResolvedValue(undefined),
    };
    pinOutcome = { apply: jest.fn().mockResolvedValue(undefined) };
    orchestrator = { handleMessage: jest.fn() };
    messenger = { sendText: jest.fn().mockResolvedValue(undefined) };
    service = new ConversationRouterService(
      onboarding as any,
      {} as any,
      { getActiveDraft: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      { getActiveDraft: jest.fn().mockResolvedValue(null) } as any,
      pinGate as any,
      orchestrator as any,
      { execute: jest.fn() } as any,
      { getReviewAwaitingLimit: jest.fn().mockResolvedValue(null) } as any,
      pinOutcome as any,
      messenger as any,
    );
  });

  describe("forms", () => {
    it("hands a PIN form to the gate, then does exactly what the gate decided", async () => {
      pinGate.handlePinFlowReply.mockResolvedValue({
        action: "execute_transfer",
        transactionId: "txn-1",
      });
      const sensitive = { pin: "4821" };

      await service.handlePinForm(
        onboardingUser,
        { flow_token: "tok" },
        sensitive,
      );

      expect(pinGate.handlePinFlowReply).toHaveBeenCalledWith(
        onboardingUser,
        { flow_token: "tok" },
        sensitive,
      );
      expect(pinOutcome.apply).toHaveBeenCalledWith(
        { action: "execute_transfer", transactionId: "txn-1" },
        "user-1",
      );
    });

    it("hands a KYC form to onboarding with the ID number kept apart", async () => {
      const sensitive = {
        id_number: "22123456789",
        date_of_birth: "1990-01-01",
      };
      const user = { ...onboardingUser, onboardingStage: "PLAN_PROPOSED" };

      await service.handleKycForm(user, { flow_token: "tok" }, sensitive);

      expect(onboarding.handleInboundFlowReply).toHaveBeenCalledWith(
        user,
        { flow_token: "tok" },
        sensitive,
      );
    });

    it("ignores a KYC form from someone who already has an account", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();

      await service.handleKycForm(
        { ...onboardingUser, onboardingStage: OnboardingStage.COMPLETE },
        { flow_token: "tok" },
        { id_number: "22123456789" },
      );

      expect(onboarding.handleInboundFlowReply).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("an app-only user's PIN, straight after KYC", () => {
    it("asks for the PIN as soon as the account is created", async () => {
      onboarding.isAwaitingPinSetup.mockResolvedValue(true);
      const user = { ...onboardingUser, onboardingStage: "PLAN_PROPOSED" };

      await service.handleKycForm(user, { flow_token: "tok" }, {});

      expect(onboarding.isAwaitingPinSetup).toHaveBeenCalledWith("user-1");
      expect(pinGate.requestPinSetup).toHaveBeenCalledWith(user);
    });

    it("does not ask when the account was not created, or the user needs no PIN yet", async () => {
      await service.handleKycForm(
        { ...onboardingUser, onboardingStage: "PLAN_PROPOSED" },
        { flow_token: "tok" },
        {},
      );

      expect(pinGate.requestPinSetup).not.toHaveBeenCalled();
    });

    it("holds onboarding until it is set: text gets the form again, not the next question", async () => {
      onboarding.isAwaitingPinSetup.mockResolvedValue(true);

      await service.handleText(onboardingUser, "i want to save for a car");

      expect(onboarding.handleInboundText).not.toHaveBeenCalled();
      expect(messenger.sendText).toHaveBeenCalledWith(
        onboardingUser,
        expect.stringContaining("set your transfer pin first"),
      );
      expect(pinGate.requestPinSetup).toHaveBeenCalledWith(onboardingUser);
    });

    it("holds onboarding buttons the same way", async () => {
      onboarding.isAwaitingPinSetup.mockResolvedValue(true);

      await service.handleChoice(onboardingUser, "money_story:yes");

      expect(onboarding.handleInboundButton).not.toHaveBeenCalled();
      expect(pinGate.requestPinSetup).toHaveBeenCalled();
    });

    it("carries on with onboarding as normal otherwise", async () => {
      await service.handleText(onboardingUser, "i want to save for a car");

      expect(onboarding.handleInboundText).toHaveBeenCalledWith(
        onboardingUser,
        "i want to save for a car",
      );
      expect(pinGate.requestPinSetup).not.toHaveBeenCalled();
    });
  });
});
