import { Logger } from "@nestjs/common";
import { codeDigest } from "./secret-hash.util";
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EmailVerificationService,
} from "./email-verification.service";

const PEPPER = "test-pepper";
const now = new Date("2026-10-09T12:00:00Z");
const MIN = 60_000;

describe("EmailVerificationService", () => {
  const user = {
    id: "user-1",
    name: "Ada",
    email: "ada@example.com",
    emailVerifiedAt: null,
  };
  let prisma: any;
  let email: { sendEmailVerificationCode: jest.Mock };
  let service: EmailVerificationService;

  const digestFor = (code: string, address = user.email, userId = user.id) =>
    codeDigest(PEPPER, `email:${userId}:${address}`, code);

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      emailVerification: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(async ({ data }) => ({ id: "ev-1", ...data })),
      },
    };
    email = { sendEmailVerificationCode: jest.fn().mockResolvedValue(true) };
    service = new EmailVerificationService(
      prisma,
      email as any,
      {
        otpPepper: PEPPER,
      } as any,
    );
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe("start", () => {
    it("stores only an HMAC bound to the user and the address, and emails the code", async () => {
      const result = await service.start("user-1", now);

      expect(result).toEqual({
        ok: true,
        sentTo: "ad*@example.com",
        expiresAt: new Date(now.getTime() + 10 * MIN),
        resendAfter: new Date(now.getTime() + MIN),
      });
      const { data } = prisma.emailVerification.create.mock.calls[0][0];
      const { code } = email.sendEmailVerificationCode.mock.calls[0][0];
      expect(code).toMatch(/^\d{6}$/);
      expect(data).toEqual({
        userId: "user-1",
        email: "ada@example.com",
        codeHmac: digestFor(code),
        expiresAt: new Date(now.getTime() + 10 * MIN),
      });
      expect(JSON.stringify(data)).not.toContain(code);
      // Earlier codes die first: only the newest is ever valid.
      expect(prisma.emailVerification.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", consumedAt: null },
        data: { consumedAt: now },
      });
      expect(email.sendEmailVerificationCode).toHaveBeenCalledWith({
        user,
        code,
        verificationId: "ev-1",
        expiresInMinutes: 10,
      });
    });

    it("needs an address, and does nothing for one already verified", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        ...user,
        email: null,
      });
      await expect(service.start("user-1", now)).resolves.toEqual({
        ok: false,
        reason: "no_email",
      });

      prisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        ...user,
        emailVerifiedAt: now,
      });
      await expect(service.start("user-1", now)).resolves.toEqual({
        ok: false,
        reason: "already_verified",
      });
      expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    });

    it("sends at most one code a minute and five an hour", async () => {
      prisma.emailVerification.findFirst.mockResolvedValueOnce({
        createdAt: new Date(now.getTime() - 30_000),
      });
      await expect(service.start("user-1", now)).resolves.toEqual({
        ok: false,
        reason: "too_soon",
        retryAfter: new Date(now.getTime() + 30_000),
      });

      prisma.emailVerification.count.mockResolvedValueOnce(5);
      await expect(service.start("user-1", now)).resolves.toEqual({
        ok: false,
        reason: "too_many_codes",
      });
      expect(email.sendEmailVerificationCode).not.toHaveBeenCalled();
    });

    it("kills the code and says so when the email does not go", async () => {
      email.sendEmailVerificationCode.mockResolvedValue(false);

      await expect(service.start("user-1", now)).resolves.toEqual({
        ok: false,
        reason: "email_unavailable",
      });
      expect(prisma.emailVerification.update).toHaveBeenCalledWith({
        where: { id: "ev-1" },
        data: { consumedAt: now },
      });
    });
  });

  describe("confirm", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: "ev-1",
      userId: "user-1",
      email: "ada@example.com",
      codeHmac: digestFor("482913"),
      attempts: 0,
      expiresAt: new Date(now.getTime() + 5 * MIN),
      consumedAt: null,
      ...overrides,
    });

    it("verifies the address with the right code, while it is still the one on file", async () => {
      prisma.emailVerification.findFirst.mockResolvedValue(row());

      await expect(service.confirm("user-1", "482913", now)).resolves.toEqual({
        ok: true,
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", email: "ada@example.com" },
        data: { emailVerifiedAt: now },
      });
    });

    it("claims the attempt atomically before comparing, and says how many are left", async () => {
      prisma.emailVerification.findFirst.mockResolvedValue(
        row({ attempts: 1 }),
      );

      await expect(service.confirm("user-1", "000000", now)).resolves.toEqual({
        ok: false,
        reason: "invalid_code",
        attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - 2,
      });
      expect(prisma.emailVerification.updateMany).toHaveBeenCalledWith({
        where: { id: "ev-1", consumedAt: null, attempts: { lt: 5 } },
        data: { attempts: { increment: 1 } },
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("kills the code on the last wrong try, and refuses once exhausted", async () => {
      prisma.emailVerification.findFirst.mockResolvedValue(
        row({ attempts: 4 }),
      );
      await expect(service.confirm("user-1", "000000", now)).resolves.toEqual({
        ok: false,
        reason: "exhausted",
      });

      prisma.emailVerification.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.confirm("user-1", "482913", now)).resolves.toEqual({
        ok: false,
        reason: "exhausted",
      });
    });

    it("refuses an expired code, and one sent to an address no longer on file", async () => {
      prisma.emailVerification.findFirst.mockResolvedValueOnce(
        row({ expiresAt: new Date(now.getTime() - 1) }),
      );
      await expect(service.confirm("user-1", "482913", now)).resolves.toEqual({
        ok: false,
        reason: "expired",
      });

      prisma.emailVerification.findFirst.mockResolvedValueOnce(
        row({
          email: "old@example.com",
          codeHmac: digestFor("482913", "old@example.com"),
        }),
      );
      await expect(service.confirm("user-1", "482913", now)).resolves.toEqual({
        ok: false,
        reason: "no_code",
      });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("never verifies with a code bound to someone else", async () => {
      prisma.emailVerification.findFirst.mockResolvedValue(
        row({ codeHmac: digestFor("482913", user.email, "user-2") }),
      );

      await expect(
        service.confirm("user-1", "482913", now),
      ).resolves.toMatchObject({
        ok: false,
        reason: "invalid_code",
      });
    });

    it("rejects a malformed code without spending an attempt", async () => {
      await expect(service.confirm("user-1", "12ab56", now)).resolves.toEqual({
        ok: false,
        reason: "invalid_code",
      });
      expect(prisma.emailVerification.updateMany).not.toHaveBeenCalled();
    });
  });
});
