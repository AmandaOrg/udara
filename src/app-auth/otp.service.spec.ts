import { Logger } from "@nestjs/common";
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_IP_PER_HOUR,
  OTP_MAX_PER_PHONE_PER_HOUR,
  OtpService,
} from "./otp.service";
import { codeDigest } from "./secret-hash.util";

const PEPPER = "p".repeat(32);
const PHONE = "2348012345678";

describe("OtpService", () => {
  let prisma: {
    authOtp: {
      findFirst: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let sms: { send: jest.Mock };
  let config: { otpPepper: string; smsDailyCap: number };
  let service: OtpService;
  const now = new Date("2026-09-25T12:00:00Z");

  beforeEach(() => {
    prisma = {
      authOtp: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(async ({ data }: any) => ({ id: "otp-1", ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    sms = { send: jest.fn().mockResolvedValue(true) };
    config = { otpPepper: PEPPER, smsDailyCap: 500 };
    service = new OtpService(prisma as any, sms as any, config as any);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe("request", () => {
    it("stores only the HMAC of the code, then texts the code", async () => {
      const result = await service.request(PHONE, "10.0.0.1", now);

      expect(result).toEqual({
        ok: true,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        resendAfter: new Date(now.getTime() + 60_000),
      });
      const [phone, text] = sms.send.mock.calls[0];
      const code = /(\d{6})/.exec(text)![1];
      expect(phone).toBe(PHONE);
      const stored = prisma.authOtp.create.mock.calls[0][0].data;
      expect(stored.codeHmac).toBe(codeDigest(PEPPER, PHONE, code));
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(stored.requestIp).toBe("10.0.0.1");
    });

    it("cancels any earlier code for the number, so only the newest works", async () => {
      await service.request(PHONE, null, now);

      expect(prisma.authOtp.updateMany).toHaveBeenCalledWith({
        where: { phoneNumber: PHONE, consumedAt: null },
        data: { consumedAt: now },
      });
    });

    it("refuses a resend within a minute of the last code", async () => {
      prisma.authOtp.findFirst.mockResolvedValue({
        createdAt: new Date(now.getTime() - 30_000),
      });

      const result = await service.request(PHONE, null, now);

      expect(result).toEqual({
        ok: false,
        reason: "too_soon",
        retryAfter: new Date(now.getTime() + 30_000),
      });
      expect(sms.send).not.toHaveBeenCalled();
    });

    it.each([
      ["the number", OTP_MAX_PER_PHONE_PER_HOUR, 0],
      ["the requesting address", 0, OTP_MAX_PER_IP_PER_HOUR],
    ])(
      "stops sending once %s hits its hourly limit",
      async (_what, perPhone, perIp) => {
        prisma.authOtp.count
          .mockResolvedValueOnce(perPhone)
          .mockResolvedValueOnce(perIp);

        const result = await service.request(PHONE, "10.0.0.1", now);

        expect(result).toEqual({ ok: false, reason: "rate_limited" });
        expect(sms.send).not.toHaveBeenCalled();
      },
    );

    /** The defence against SMS pumping: a hard daily ceiling that alerts. */
    it("refuses every number once the global daily cap is reached, and says so loudly", async () => {
      prisma.authOtp.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(500);

      const result = await service.request(PHONE, "10.0.0.1", now);

      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(sms.send).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("daily cap"),
      );
    });

    it("voids the code when the SMS could not be sent", async () => {
      sms.send.mockResolvedValue(false);

      const result = await service.request(PHONE, null, now);

      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(prisma.authOtp.update).toHaveBeenCalledWith({
        where: { id: "otp-1" },
        data: { consumedAt: now },
      });
    });
  });

  describe("verify", () => {
    function storedOtp(overrides: Record<string, unknown> = {}) {
      return {
        id: "otp-1",
        phoneNumber: PHONE,
        codeHmac: codeDigest(PEPPER, PHONE, "123456"),
        attempts: 0,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: null,
        ...overrides,
      };
    }

    it("accepts the right code once, consuming it", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(storedOtp());

      expect(await service.verify(PHONE, "123456", now)).toEqual({ ok: true });
      expect(prisma.authOtp.updateMany).toHaveBeenLastCalledWith({
        where: { id: "otp-1", consumedAt: null },
        data: { consumedAt: now },
      });
    });

    it("lets only one of two simultaneous correct submissions through", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(storedOtp());
      prisma.authOtp.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      expect(await service.verify(PHONE, "123456", now)).toEqual({
        ok: false,
        reason: "invalid",
      });
    });

    it("counts a wrong code against the budget and says how many are left", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(storedOtp({ attempts: 1 }));

      expect(await service.verify(PHONE, "000000", now)).toEqual({
        ok: false,
        reason: "invalid",
        attemptsLeft: OTP_MAX_ATTEMPTS - 2,
      });
      expect(prisma.authOtp.updateMany).toHaveBeenCalledWith({
        where: {
          id: "otp-1",
          consumedAt: null,
          attempts: { lt: OTP_MAX_ATTEMPTS },
        },
        data: { attempts: { increment: 1 } },
      });
    });

    it("burns the code on the last wrong guess", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(
        storedOtp({ attempts: OTP_MAX_ATTEMPTS - 1 }),
      );

      expect(await service.verify(PHONE, "000000", now)).toEqual({
        ok: false,
        reason: "exhausted",
      });
    });

    it("refuses once the attempt budget is gone, even for the right code", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(storedOtp());
      prisma.authOtp.updateMany.mockResolvedValueOnce({ count: 0 });

      expect(await service.verify(PHONE, "123456", now)).toEqual({
        ok: false,
        reason: "exhausted",
      });
    });

    it("refuses an expired code without spending an attempt", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(
        storedOtp({ expiresAt: new Date(now.getTime() - 1) }),
      );

      expect(await service.verify(PHONE, "123456", now)).toEqual({
        ok: false,
        reason: "expired",
      });
      expect(prisma.authOtp.updateMany).not.toHaveBeenCalled();
    });

    it("does not accept a code issued to a different number", async () => {
      prisma.authOtp.findFirst.mockResolvedValue(
        storedOtp({ codeHmac: codeDigest(PEPPER, "2348099999999", "123456") }),
      );

      expect(await service.verify(PHONE, "123456", now)).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    });

    it("rejects anything that is not six digits without touching the database", async () => {
      expect(await service.verify(PHONE, "12345", now)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(prisma.authOtp.findFirst).not.toHaveBeenCalled();
    });
  });
});
