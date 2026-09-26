import { DevicePlatform, LoginStepUpMethod, Prisma } from "@prisma/client";
import { LoginService } from "./login.service";
import { tokenDigest } from "./secret-hash.util";

describe("LoginService", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const PHONE = "2348012345678";
  const tokens = {
    accessToken: "udr_at_a",
    accessExpiresAt: now,
    refreshToken: "udr_rt_r",
    refreshExpiresAt: now,
  };

  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    device: { create: jest.Mock; update: jest.Mock };
    loginChallenge: {
      create: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let otp: { verify: jest.Mock };
  let sessions: { issue: jest.Mock };
  let pin: { verifyPin: jest.Mock };
  let messenger: { sendText: jest.Mock; sendButtons: jest.Mock };
  let email: { sendNewDeviceLogin: jest.Mock };
  let service: LoginService;

  const device = {
    id: "device-1",
    name: "Tecno Spark",
    platform: DevicePlatform.ANDROID,
    revokedAt: null,
  };

  function userWith(overrides: Record<string, unknown> = {}) {
    return {
      id: "user-1",
      phoneNumber: PHONE,
      whatsappNumber: null,
      pinHash: null,
      ...overrides,
    };
  }

  function signIn() {
    return service.signIn(
      {
        phoneNumber: PHONE,
        code: "123456",
        platform: DevicePlatform.ANDROID,
        deviceName: "Tecno Spark",
      },
      now,
    );
  }

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => userWith(data)),
        findUniqueOrThrow: jest.fn(),
      },
      device: {
        create: jest.fn().mockResolvedValue(device),
        update: jest.fn().mockResolvedValue(undefined),
      },
      loginChallenge: {
        create: jest.fn(async ({ data }: any) => ({
          id: "challenge-1",
          ...data,
        })),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    otp = { verify: jest.fn().mockResolvedValue({ ok: true }) };
    sessions = { issue: jest.fn().mockResolvedValue(tokens) };
    pin = { verifyPin: jest.fn().mockResolvedValue({ ok: true }) };
    messenger = {
      sendText: jest.fn().mockResolvedValue(undefined),
      sendButtons: jest.fn().mockResolvedValue(undefined),
    };
    email = { sendNewDeviceLogin: jest.fn().mockResolvedValue(undefined) };
    service = new LoginService(
      prisma as any,
      otp as any,
      sessions as any,
      pin as any,
      messenger as any,
      email as any,
    );
  });

  describe("signIn", () => {
    it("creates nothing when the code is wrong", async () => {
      otp.verify.mockResolvedValue({
        ok: false,
        reason: "invalid",
        attemptsLeft: 3,
      });

      expect(await signIn()).toEqual({
        status: "invalid_code",
        reason: "invalid",
        attemptsLeft: 3,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it("signs a brand-new number straight in, creating the user only after the code", async () => {
      const outcome = await signIn();

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { phoneNumber: PHONE },
      });
      expect(prisma.device.update).toHaveBeenCalledWith({
        where: { id: "device-1" },
        data: { trustedAt: now },
      });
      expect(outcome).toEqual({
        status: "authenticated",
        tokens,
        userId: "user-1",
        isNewUser: true,
      });
      // A brand-new account has nobody else to warn.
      expect(email.sendNewDeviceLogin).not.toHaveBeenCalled();
      expect(messenger.sendText).not.toHaveBeenCalled();
    });

    /**
     * An account with a PIN has money worth taking. A swapped SIM gets the SMS
     * code, not the PIN, so the code alone must not be enough.
     */
    it("holds back tokens and asks for the PIN when the account has one", async () => {
      prisma.user.findUnique.mockResolvedValue(
        userWith({ pinHash: "scrypt$..." }),
      );

      const outcome = await signIn();

      expect(outcome).toMatchObject({
        status: "step_up_required",
        method: "pin",
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      });
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(prisma.device.update).not.toHaveBeenCalled();
      const { challengeToken } = outcome as { challengeToken: string };
      expect(prisma.loginChallenge.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          method: LoginStepUpMethod.PIN,
          tokenHash: tokenDigest(challengeToken),
        }),
      });
    });

    it("asks on WhatsApp when there is no PIN but a WhatsApp conversation", async () => {
      prisma.user.findUnique.mockResolvedValue(
        userWith({ whatsappNumber: PHONE }),
      );

      const outcome = await signIn();

      expect(outcome).toMatchObject({
        status: "step_up_required",
        method: "whatsapp",
      });
      expect(messenger.sendButtons).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user-1" }),
        expect.stringContaining("Tecno Spark"),
        [
          { id: "login_approve:challenge-1", title: "Yes, it's me" },
          { id: "login_deny:challenge-1", title: "No, block it" },
        ],
        { delivery: "transactional", channel: "whatsapp" },
      );
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it("tells an existing app-only user by email when they sign in again", async () => {
      prisma.user.findUnique.mockResolvedValue(userWith());

      const outcome = await signIn();

      expect(outcome).toMatchObject({
        status: "authenticated",
        isNewUser: false,
      });
      expect(email.sendNewDeviceLogin).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: "device-1", platform: "Android" }),
      );
    });

    it("uses the account a first WhatsApp message created at the same moment", async () => {
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "5.22.0",
        }),
      );
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        userWith({ whatsappNumber: PHONE }),
      );

      expect(await signIn()).toMatchObject({
        status: "step_up_required",
        method: "whatsapp",
      });
    });
  });

  describe("stepUpWithPin", () => {
    function pinChallenge(overrides: Record<string, unknown> = {}) {
      return {
        id: "challenge-1",
        userId: "user-1",
        method: LoginStepUpMethod.PIN,
        consumedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        user: userWith({ pinHash: "h", whatsappNumber: PHONE }),
        device,
        ...overrides,
      };
    }

    it("trusts the device and issues tokens for the right PIN, warning the other channels", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(pinChallenge());

      const outcome = await service.stepUpWithPin("udr_lc_x", "8317", now);

      expect(pin.verifyPin).toHaveBeenCalledWith("user-1", "8317", now);
      expect(outcome).toMatchObject({ status: "authenticated" });
      expect(prisma.device.update).toHaveBeenCalledWith({
        where: { id: "device-1" },
        data: { trustedAt: now },
      });
      expect(messenger.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user-1" }),
        expect.stringContaining("heads up"),
        { delivery: "transactional", channel: "whatsapp" },
      );
      expect(email.sendNewDeviceLogin).toHaveBeenCalled();
    });

    it("passes a wrong PIN's message through and keeps the challenge open", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(pinChallenge());
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "that pin isn't right. 2 tries left before it locks.",
      });

      expect(await service.stepUpWithPin("udr_lc_x", "0000", now)).toEqual({
        status: "wrong_pin",
        message: "that pin isn't right. 2 tries left before it locks.",
      });
      expect(prisma.loginChallenge.updateMany).not.toHaveBeenCalled();
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it("reports the transfer-PIN lockout it shares", async () => {
      const lockedUntil = new Date(now.getTime() + 15 * 60_000);
      prisma.loginChallenge.findUnique.mockResolvedValue(pinChallenge());
      pin.verifyPin.mockResolvedValue({
        ok: false,
        reason: "locked",
        lockedUntil,
      });

      expect(await service.stepUpWithPin("udr_lc_x", "0000", now)).toEqual({
        status: "locked",
        lockedUntil,
      });
    });

    it.each([
      ["unknown", null],
      ["already used", pinChallenge({ consumedAt: now })],
      [
        "for WhatsApp, not a PIN",
        pinChallenge({ method: LoginStepUpMethod.WHATSAPP }),
      ],
    ])(
      "refuses a challenge that is %s without checking the PIN",
      async (_why, challenge) => {
        prisma.loginChallenge.findUnique.mockResolvedValue(challenge);

        expect(await service.stepUpWithPin("udr_lc_x", "8317", now)).toEqual({
          status: "invalid_challenge",
        });
        expect(pin.verifyPin).not.toHaveBeenCalled();
      },
    );

    it("refuses an expired challenge without spending a PIN attempt", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(
        pinChallenge({ expiresAt: now }),
      );

      expect(await service.stepUpWithPin("udr_lc_x", "8317", now)).toEqual({
        status: "expired",
      });
      expect(pin.verifyPin).not.toHaveBeenCalled();
    });

    it("issues tokens to only one of two parallel correct submissions", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(pinChallenge());
      prisma.loginChallenge.updateMany.mockResolvedValue({ count: 0 });

      expect(await service.stepUpWithPin("udr_lc_x", "8317", now)).toEqual({
        status: "invalid_challenge",
      });
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  describe("pollWhatsappApproval", () => {
    function waChallenge(overrides: Record<string, unknown> = {}) {
      return {
        id: "challenge-1",
        userId: "user-1",
        method: LoginStepUpMethod.WHATSAPP,
        approvedAt: null,
        rejectedAt: null,
        consumedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        user: userWith({ whatsappNumber: PHONE }),
        device,
        ...overrides,
      };
    }

    it("waits until the user answers", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(waChallenge());

      expect(await service.pollWhatsappApproval("udr_lc_x", now)).toEqual({
        status: "pending",
      });
    });

    it("signs in once approved, without echoing a WhatsApp warning they just answered", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(
        waChallenge({ approvedAt: now }),
      );

      expect(await service.pollWhatsappApproval("udr_lc_x", now)).toMatchObject(
        {
          status: "authenticated",
        },
      );
      expect(messenger.sendText).not.toHaveBeenCalled();
      expect(email.sendNewDeviceLogin).toHaveBeenCalled();
    });

    it("never signs in after a refusal", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(
        waChallenge({ rejectedAt: now }),
      );

      expect(await service.pollWhatsappApproval("udr_lc_x", now)).toEqual({
        status: "denied",
      });
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it("expires an unanswered request", async () => {
      prisma.loginChallenge.findUnique.mockResolvedValue(
        waChallenge({ expiresAt: now }),
      );

      expect(await service.pollWhatsappApproval("udr_lc_x", now)).toEqual({
        status: "expired",
      });
    });
  });
});
