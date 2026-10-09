import { PinGateService } from "./pin-gate.service";
import { PinChallengePurpose } from "@prisma/client";
import { whatsappTestMessenger } from "../messaging/testing/whatsapp-test-messenger";

describe("PinGateService", () => {
  let prisma: { transaction: { updateMany: jest.Mock } };
  let config: { get: jest.Mock };
  let pin: {
    createChallenge: jest.Mock;
    consumeChallenge: jest.Mock;
    verifyPin: jest.Mock;
    setPin: jest.Mock;
    isLocked: jest.Mock;
    canRequestReset: jest.Mock;
    createResetChallenge: jest.Mock;
    verifyResetOtp: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock; sendFlow: jest.Mock };
  let emailNotifications: { sendPinResetOtp: jest.Mock };
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
            : key === "WHATSAPP_PIN_RESET_FLOW_ID"
              ? "reset-flow"
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
      canRequestReset: jest.fn().mockResolvedValue(true),
      createResetChallenge: jest.fn().mockResolvedValue({
        challenge: { id: "c-reset", flowToken: "tok-reset" },
        otp: "123456",
      }),
      verifyResetOtp: jest.fn(),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "w1" }),
      sendFlow: jest.fn().mockResolvedValue({ waMessageId: "w2" }),
    };
    emailNotifications = {
      sendPinResetOtp: jest.fn().mockResolvedValue(true),
    };
    service = new PinGateService(
      prisma as any,
      pin as any,
      whatsappTestMessenger({ whatsapp, config }),
      emailNotifications as any,
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

      expect(outcome).toEqual({ action: "pin_setup_complete" });
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
  describe("PIN reset", () => {
    const resetUser = {
      ...user,
      pinHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
      email: "daniel@example.com",
    } as any;

    /** Everything sent to the user this test. */
    const sentText = () =>
      whatsapp.sendText.mock.calls.map((c: any[]) => c[1]).join("\n");

    describe("requesting a code", () => {
      it("emails a code and sends the reset form bound to the challenge", async () => {
        await service.requestPinReset(resetUser);

        expect(emailNotifications.sendPinResetOtp).toHaveBeenCalledWith(
          expect.objectContaining({
            otp: "123456",
            challengeId: "c-reset",
            expiresInMinutes: 10,
          }),
        );
        expect(whatsapp.sendFlow).toHaveBeenCalledWith(
          expect.objectContaining({
            flowId: "reset-flow",
            flowToken: "tok-reset",
          }),
        );
      });

      it("masks the email address rather than printing it into the chat", async () => {
        await service.requestPinReset(resetUser);

        const text = sentText();
        expect(text).toContain("da");
        expect(text).toContain("@example.com");
        expect(text).not.toContain("daniel@example.com");
      });

      it("works while the PIN is locked, since that's the way out of a lockout", async () => {
        pin.isLocked.mockReturnValue(true);

        await service.requestPinReset({
          ...resetUser,
          pinLockedUntil: new Date(Date.now() + 60_000),
        });

        expect(pin.createResetChallenge).toHaveBeenCalled();
        expect(whatsapp.sendFlow).toHaveBeenCalled();
      });

      it("refuses when there's no email on file, since the email IS the second factor", async () => {
        await service.requestPinReset({ ...resetUser, email: null });

        expect(pin.createResetChallenge).not.toHaveBeenCalled();
        expect(whatsapp.sendFlow).not.toHaveBeenCalled();
        expect(sentText()).toContain("no email address");
      });

      it("sends someone with no PIN to setup instead of minting a pointless code", async () => {
        await service.requestPinReset({ ...resetUser, pinHash: null });

        expect(pin.createResetChallenge).not.toHaveBeenCalled();
        expect(pin.createChallenge).toHaveBeenCalledWith(
          expect.objectContaining({ purpose: PinChallengePurpose.SETUP }),
        );
      });

      it("refuses once the hourly issuance ceiling is hit", async () => {
        pin.canRequestReset.mockResolvedValue(false);

        await service.requestPinReset(resetUser);

        expect(pin.createResetChallenge).not.toHaveBeenCalled();
        expect(whatsapp.sendFlow).not.toHaveBeenCalled();
        expect(sentText()).toContain("give it an hour");
      });

      it("says so plainly when the code email could not be sent", async () => {
        emailNotifications.sendPinResetOtp.mockResolvedValue(false);

        await service.requestPinReset(resetUser);

        expect(whatsapp.sendFlow).not.toHaveBeenCalled();
        expect(sentText()).toContain("couldn't send the reset code");
      });
    });

    describe("submitting the form", () => {
      function resetChallenge(overrides: any = {}) {
        return {
          id: "c-reset",
          userId: "user-1",
          purpose: PinChallengePurpose.RESET,
          otpHash: "scrypt$hash",
          otpAttempts: 0,
          expiresAt: new Date(Date.now() + 600_000),
          transactionId: null,
          ...overrides,
        };
      }

      it("sets the new PIN when the code is right", async () => {
        pin.consumeChallenge.mockResolvedValue(resetChallenge());
        pin.verifyResetOtp.mockResolvedValue({ ok: true });
        pin.setPin.mockResolvedValue({ ok: true });

        const outcome = await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "123456", pin: "8317", pin_confirm: "8317" },
        );

        expect(pin.setPin).toHaveBeenCalledWith("user-1", "8317", "8317");
        expect(outcome).toEqual({ action: "none" });
        expect(sentText()).toContain("pin has been reset");
      });

      it("checks the code BEFORE the new PIN, so a wrong code reveals nothing about the PIN", async () => {
        pin.consumeChallenge.mockResolvedValue(resetChallenge());
        pin.verifyResetOtp.mockResolvedValue({
          ok: false,
          exhausted: false,
          retryChallenge: { flowToken: "tok-retry" },
          attemptsLeft: 4,
        });

        await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "000000", pin: "1234", pin_confirm: "1234" }, // a weak PIN
        );

        expect(pin.setPin).not.toHaveBeenCalled();
        expect(sentText()).not.toContain("too easy to guess");
      });

      it("re-sends the form on a wrong code, telling them how many tries remain", async () => {
        pin.consumeChallenge.mockResolvedValue(resetChallenge());
        pin.verifyResetOtp.mockResolvedValue({
          ok: false,
          exhausted: false,
          retryChallenge: { flowToken: "tok-retry" },
          attemptsLeft: 3,
        });

        await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "000000", pin: "8317", pin_confirm: "8317" },
        );

        expect(sentText()).toContain("3 tries left");
        expect(whatsapp.sendFlow).toHaveBeenCalledWith(
          expect.objectContaining({ flowToken: "tok-retry" }),
        );
      });

      it("abandons the reset once attempts are exhausted, leaving the PIN unchanged", async () => {
        pin.consumeChallenge.mockResolvedValue(resetChallenge());
        pin.verifyResetOtp.mockResolvedValue({ ok: false, exhausted: true });

        await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "000000", pin: "8317", pin_confirm: "8317" },
        );

        expect(pin.setPin).not.toHaveBeenCalled();
        expect(whatsapp.sendFlow).not.toHaveBeenCalled();
        expect(sentText()).toContain("hasn't changed");
      });

      it("does not make them re-verify when the code was right but the PIN was weak", async () => {
        pin.consumeChallenge.mockResolvedValue(resetChallenge());
        pin.verifyResetOtp.mockResolvedValue({ ok: true });
        pin.setPin.mockResolvedValue({
          ok: false,
          reason: "that pin is too easy to guess, don't use digits in a row.",
        });
        pin.createChallenge.mockResolvedValue({ flowToken: "tok-again" });

        await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "123456", pin: "1234", pin_confirm: "1234" },
        );

        expect(sentText()).toContain("too easy to guess");
        // A successor challenge carrying the already-verified code forward.
        expect(pin.createChallenge).toHaveBeenCalledWith(
          expect.objectContaining({
            purpose: PinChallengePurpose.RESET,
            otpHash: "scrypt$hash",
          }),
        );
        expect(whatsapp.sendFlow).toHaveBeenCalledWith(
          expect.objectContaining({ flowToken: "tok-again" }),
        );
      });

      it("never returns execute_transfer from a reset, whatever is submitted", async () => {
        pin.consumeChallenge.mockResolvedValue(
          resetChallenge({ transactionId: "txn-1" }),
        );
        pin.verifyResetOtp.mockResolvedValue({ ok: true });
        pin.setPin.mockResolvedValue({ ok: true });

        const outcome = await service.handlePinFlowReply(
          resetUser,
          { flow_token: "tok-reset" },
          { otp: "123456", pin: "8317", pin_confirm: "8317" },
        );

        expect(outcome).toEqual({ action: "none" });
      });
    });
  });

  /** The app's native send screen: the same checks, answered as data. */
  describe("authorizeTransfer", () => {
    const challenge = {
      id: "c1",
      purpose: PinChallengePurpose.TRANSFER_AUTH,
      transactionId: "txn-1",
      billPaymentId: null,
    };

    it("verifies a PIN for the transaction the token was issued for, and says nothing in the chat", async () => {
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({ ok: true });

      await expect(
        service.authorizeTransfer(user, "tok-1", "txn-1", "1234"),
      ).resolves.toEqual({
        kind: "verified",
        outcome: { action: "execute_transfer", transactionId: "txn-1" },
      });
      expect(pin.consumeChallenge).toHaveBeenCalledWith("tok-1", "user-1");
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    });

    it.each([
      ["another transaction", { ...challenge, transactionId: "txn-2" }],
      [
        "a bill payment",
        { ...challenge, transactionId: null, billPaymentId: "bill-1" },
      ],
      [
        "PIN setup",
        {
          ...challenge,
          purpose: PinChallengePurpose.SETUP,
          transactionId: null,
        },
      ],
      ["nothing (unknown, used or expired)", null],
    ])(
      "refuses a token issued for %s without checking the PIN",
      async (_label, found) => {
        pin.consumeChallenge.mockResolvedValue(found);

        await expect(
          service.authorizeTransfer(user, "tok-1", "txn-1", "1234"),
        ).resolves.toEqual({ kind: "expired" });
        expect(pin.verifyPin).not.toHaveBeenCalled();
      },
    );

    it("answers a wrong PIN with the reason and a fresh token for the same transfer", async () => {
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "that pin isn't right. 2 tries left.",
      });
      pin.createChallenge.mockResolvedValue({ id: "c2", flowToken: "tok-2" });

      await expect(
        service.authorizeTransfer(user, "tok-1", "txn-1", "0000"),
      ).resolves.toEqual({
        kind: "wrong_pin",
        message: "that pin isn't right. 2 tries left.",
        retryToken: "tok-2",
      });
      expect(pin.createChallenge).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: PinChallengePurpose.TRANSFER_AUTH,
          transactionId: "txn-1",
        }),
      );
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    });

    it("cancels the transfer when the PIN locks, and issues no new token", async () => {
      const until = new Date("2026-09-26T12:30:00Z");
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "too many wrong attempts.",
        lockedUntil: until,
      });

      await expect(
        service.authorizeTransfer(user, "tok-1", "txn-1", "0000"),
      ).resolves.toEqual({
        kind: "locked",
        message: "too many wrong attempts.",
        lockedUntil: until,
      });
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: "txn-1", status: "PENDING_PIN" },
        data: { status: "CANCELLED" },
      });
      expect(pin.createChallenge).not.toHaveBeenCalled();
    });
  });

  describe("issuing tokens without a form", () => {
    it("binds a transfer token to its transaction and sends nothing", async () => {
      await expect(service.issueTransferPinToken(user, "txn-1")).resolves.toBe(
        "tok-1",
      );
      expect(pin.createChallenge).toHaveBeenCalledWith({
        userId: "user-1",
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        transactionId: "txn-1",
      });
      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    });

    it("issues a setup token and sends nothing", async () => {
      await expect(service.issuePinSetupToken(user)).resolves.toBe("tok-1");
      expect(pin.createChallenge).toHaveBeenCalledWith({
        userId: "user-1",
        purpose: PinChallengePurpose.SETUP,
      });
      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    });
  });

  /** The app's native bill screen (P8): the same check, bound to the purchase. */
  describe("authorizeBillPayment", () => {
    const challenge = {
      id: "c1",
      purpose: PinChallengePurpose.TRANSFER_AUTH,
      transactionId: null,
      billPaymentId: "bill-1",
    };

    it("verifies a PIN for the purchase the token was issued for, and says nothing in the chat", async () => {
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({ ok: true });

      await expect(
        service.authorizeBillPayment(user, "tok-1", "bill-1", "1234"),
      ).resolves.toEqual({
        kind: "verified",
        outcome: { action: "execute_bill_payment", billPaymentId: "bill-1" },
      });
      expect(whatsapp.sendText).not.toHaveBeenCalled();
      expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    });

    it.each([
      ["another purchase", { ...challenge, billPaymentId: "bill-2" }],
      [
        "a transfer",
        { ...challenge, billPaymentId: null, transactionId: "txn-1" },
      ],
      [
        "PIN setup",
        {
          ...challenge,
          purpose: PinChallengePurpose.SETUP,
          billPaymentId: null,
        },
      ],
    ])(
      "refuses a token issued for %s without checking the PIN",
      async (_label, found) => {
        pin.consumeChallenge.mockResolvedValue(found);

        await expect(
          service.authorizeBillPayment(user, "tok-1", "bill-1", "1234"),
        ).resolves.toEqual({ kind: "expired" });
        expect(pin.verifyPin).not.toHaveBeenCalled();
      },
    );

    it("answers a wrong PIN with a fresh token bound to the same purchase", async () => {
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({ ok: false, reason: "wrong." });
      pin.createChallenge.mockResolvedValue({ id: "c2", flowToken: "tok-2" });

      await expect(
        service.authorizeBillPayment(user, "tok-1", "bill-1", "0000"),
      ).resolves.toEqual({
        kind: "wrong_pin",
        message: "wrong.",
        retryToken: "tok-2",
      });
      expect(pin.createChallenge).toHaveBeenCalledWith({
        userId: "user-1",
        purpose: PinChallengePurpose.TRANSFER_AUTH,
        billPaymentId: "bill-1",
      });
    });

    it("cancels the purchase, not a transfer, when the PIN locks", async () => {
      (prisma as any).billPayment = {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      pin.consumeChallenge.mockResolvedValue(challenge);
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "locked.",
        lockedUntil: new Date("2026-10-09T12:30:00Z"),
      });

      const check = await service.authorizeBillPayment(
        user,
        "tok-1",
        "bill-1",
        "0000",
      );

      expect(check.kind).toBe("locked");
      expect((prisma as any).billPayment.updateMany).toHaveBeenCalledWith({
        where: { id: "bill-1", status: "PENDING_PIN" },
        data: { status: "CANCELLED" },
      });
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    });

    it("a transfer's token cannot approve a purchase, nor a purchase's token a transfer", async () => {
      pin.consumeChallenge.mockResolvedValue(challenge);
      await expect(
        service.authorizeTransfer(user, "tok-1", "bill-1", "1234"),
      ).resolves.toEqual({ kind: "expired" });
      expect(pin.verifyPin).not.toHaveBeenCalled();
    });
  });

  it("issues a bill PIN token bound to its purchase and sends nothing", async () => {
    await expect(
      service.issueBillPaymentPinToken(user, "bill-1"),
    ).resolves.toBe("tok-1");
    expect(pin.createChallenge).toHaveBeenCalledWith({
      userId: "user-1",
      purpose: PinChallengePurpose.TRANSFER_AUTH,
      billPaymentId: "bill-1",
    });
    expect(whatsapp.sendFlow).not.toHaveBeenCalled();
  });
});
