import { PinGateService } from "./pin-gate.service";
import { PinChallengePurpose } from "@prisma/client";

describe("PinGateService", () => {
  let prisma: { transaction: { updateMany: jest.Mock } };
  let config: { get: jest.Mock };
  let pin: {
    createChallenge: jest.Mock;
    consumeChallenge: jest.Mock;
    verifyPin: jest.Mock;
    setPin: jest.Mock;
    isLocked: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock; sendFlow: jest.Mock };
  let service: PinGateService;

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    pinLockedUntil: null,
  } as any;

  beforeEach(() => {
    prisma = {
      transaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    config = {
      get: jest.fn((key: string) =>
        key === "WHATSAPP_PIN_ENTRY_FLOW_ID"
          ? "entry-flow"
          : key === "WHATSAPP_PIN_SETUP_FLOW_ID"
            ? "setup-flow"
            : undefined,
      ),
    };
    pin = {
      createChallenge: jest
        .fn()
        .mockResolvedValue({ id: "c1", flowToken: "tok-1" }),
      consumeChallenge: jest.fn(),
      verifyPin: jest.fn(),
      setPin: jest.fn(),
      isLocked: jest.fn().mockReturnValue(false),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }),
      sendFlow: jest.fn().mockResolvedValue({ waMessageId: "w2" }),
    };
    service = new PinGateService(
      prisma as any,
      config as any,
      pin as any,
      whatsapp as any,
    );
  });

  describe("requesting a PIN", () => {
    it("binds the challenge to the specific transaction and sends the entry flow with its token", async () => {
      await service.requestTransferPin(user, "txn-1");

      expect(pin.createChallenge).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          purpose: PinChallengePurpose.TRANSFER_AUTH,
          transactionId: "txn-1",
        }),
      );
      expect(whatsapp.sendFlow).toHaveBeenCalledWith(
        expect.objectContaining({ flowId: "entry-flow", flowToken: "tok-1" }),
      );
    });

    it("creates a SETUP challenge with no transaction for first-time setup", async () => {
      await service.requestPinSetup(user);

      expect(pin.createChallenge).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: PinChallengePurpose.SETUP }),
      );
      expect(whatsapp.sendFlow).toHaveBeenCalledWith(
        expect.objectContaining({ flowId: "setup-flow" }),
      );
    });

    it("warns and tells the user plainly when the flow id isn't configured, rather than crashing", async () => {
      config.get.mockReturnValue(undefined);

      await expect(
        service.requestTransferPin(user, "txn-1"),
      ).resolves.toBeUndefined();

      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("isn't set up on this environment"),
        "user-1",
      );
    });
  });

  describe("handling a submission", () => {
    it("refuses a reply with no flow_token", async () => {
      const outcome = await service.handlePinFlowReply(
        user,
        {},
        { pin: "8317" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(pin.verifyPin).not.toHaveBeenCalled();
    });

    it("refuses an unknown/expired/replayed token without ever verifying a PIN", async () => {
      pin.consumeChallenge.mockResolvedValue(null);

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "8317" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(pin.verifyPin).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("expired or was already used"),
        "user-1",
      );
    });

    it("authorizes the bound transaction on a correct PIN", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
      });
      pin.verifyPin.mockResolvedValue({ ok: true });

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "8317" },
      );

      expect(outcome).toEqual({
        action: "execute_transfer",
        transactionId: "txn-1",
      });
    });

    it("does not authorize on a wrong PIN, and offers another attempt", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
      });
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "that pin isn't right. 2 tries left before it locks.",
      });

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "0000" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("2 tries left"),
        "user-1",
      );
      // A fresh challenge for the retry — the old token is already consumed.
      expect(pin.createChallenge).toHaveBeenCalled();
    });

    it("cancels the transfer outright when the wrong PIN triggers a lockout", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
      });
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "locked",
        lockedUntil: new Date("2026-01-08T12:15:00Z"),
      });

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "0000" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: "PENDING_PIN" },
        data: { status: "CANCELLED" },
      });
      // No retry form while locked.
      expect(pin.createChallenge).not.toHaveBeenCalled();
    });

    it("refuses a TRANSFER_AUTH challenge with no bound transaction", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: null,
      });

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "8317" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(pin.verifyPin).not.toHaveBeenCalled();
    });

    it("never returns execute_transfer for a SETUP challenge, even with a valid PIN", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.SETUP,
        transactionId: null,
      });
      pin.setPin.mockResolvedValue({ ok: true });

      const outcome = await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "8317", pin_confirm: "8317" },
      );

      expect(outcome).toEqual({ action: "none" });
      expect(pin.setPin).toHaveBeenCalledWith("user-1", "8317", "8317");
    });

    it("re-sends the setup form with the reason when the chosen PIN is rejected", async () => {
      pin.consumeChallenge.mockResolvedValue({
        purpose: PinChallengePurpose.SETUP,
        transactionId: null,
      });
      pin.setPin.mockResolvedValue({
        ok: false,
        reason: "that pin is too easy to guess, don't use digits in a row.",
      });

      await service.handlePinFlowReply(
        user,
        { flow_token: "tok-1" },
        { pin: "1234", pin_confirm: "1234" },
      );

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("too easy to guess"),
        "user-1",
      );
      expect(whatsapp.sendFlow).toHaveBeenCalledWith(
        expect.objectContaining({ flowId: "setup-flow" }),
      );
    });
  });
});
