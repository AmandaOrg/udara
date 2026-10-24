import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Sentry } from "../common/sentry";
import { AppAuthConfig } from "./app-auth.config";
import { SmsService, maskPhone } from "./sms.service";
import { codeDigest, digestsMatch, newSixDigitCode } from "./secret-hash.util";

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_AFTER_MS = 60_000;
/** Enough for a user whose SMS is slow; nowhere near enough to farm codes. */
export const OTP_MAX_PER_PHONE_PER_HOUR = 5;
/** Generous because Nigerian carriers put many phones behind one address. */
export const OTP_MAX_PER_IP_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type OtpRequestResult =
  | { ok: true; expiresAt: Date; resendAfter: Date }
  | { ok: false; reason: "too_soon"; retryAfter: Date }
  | { ok: false; reason: "rate_limited" | "unavailable" };

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; attemptsLeft?: number }
  | { ok: false; reason: "expired" | "exhausted" };

/**
 * Sign-in codes by SMS.
 *
 * Every paid send is capped three ways: per number, per requesting address,
 * and globally per day. The global cap is the one that matters against SMS
 * pumping, where attackers trigger sends to premium numbers they are paid
 * for, and hitting it alerts rather than just refusing.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly config: AppAuthConfig,
  ) {}

  async request(
    phoneNumber: string,
    requestIp: string | null,
    now: Date = new Date(),
  ): Promise<OtpRequestResult> {
    const latest = await this.prisma.authOtp.findFirst({
      where: { phoneNumber },
      orderBy: { createdAt: "desc" },
    });
    if (
      latest &&
      now.getTime() - latest.createdAt.getTime() < OTP_RESEND_AFTER_MS
    ) {
      return {
        ok: false,
        reason: "too_soon",
        retryAfter: new Date(latest.createdAt.getTime() + OTP_RESEND_AFTER_MS),
      };
    }

    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const perPhone = await this.prisma.authOtp.count({
      where: { phoneNumber, createdAt: { gte: hourAgo } },
    });
    if (perPhone >= OTP_MAX_PER_PHONE_PER_HOUR) {
      return { ok: false, reason: "rate_limited" };
    }
    if (requestIp) {
      const perIp = await this.prisma.authOtp.count({
        where: { requestIp, createdAt: { gte: hourAgo } },
      });
      if (perIp >= OTP_MAX_PER_IP_PER_HOUR) {
        return { ok: false, reason: "rate_limited" };
      }
    }

    const today = await this.prisma.authOtp.count({
      where: { createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    if (today >= this.config.smsDailyCap) {
      const message = `Sign-in SMS daily cap (${this.config.smsDailyCap}) reached — refusing further codes. Check for SMS pumping before raising SMS_DAILY_CAP.`;
      this.logger.error(message);
      Sentry.captureMessage(message, "error");
      return { ok: false, reason: "unavailable" };
    }

    // Only the newest code for a number is ever valid.
    await this.prisma.authOtp.updateMany({
      where: { phoneNumber, consumedAt: null },
      data: { consumedAt: now },
    });

    const code = newSixDigitCode();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const row = await this.prisma.authOtp.create({
      data: {
        phoneNumber,
        codeHmac: codeDigest(this.config.otpPepper, phoneNumber, code),
        requestIp,
        expiresAt,
      },
    });

    const sent = await this.sms.send(
      phoneNumber,
      `your udara code is ${code}. it expires in ${OTP_TTL_MS / 60_000} minutes. udara will never ask you for this code.`,
    );
    if (!sent) {
      await this.prisma.authOtp.update({
        where: { id: row.id },
        data: { consumedAt: now },
      });
      this.logger.warn(`Sign-in code to ${maskPhone(phoneNumber)} not sent`);
      return { ok: false, reason: "unavailable" };
    }

    return {
      ok: true,
      expiresAt,
      resendAfter: new Date(now.getTime() + OTP_RESEND_AFTER_MS),
    };
  }

  async verify(
    phoneNumber: string,
    code: string,
    now: Date = new Date(),
  ): Promise<OtpVerifyResult> {
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

    const otp = await this.prisma.authOtp.findFirst({
      where: { phoneNumber, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) return { ok: false, reason: "invalid" };
    if (otp.expiresAt <= now) return { ok: false, reason: "expired" };

    // Claim the attempt before comparing, atomically, so parallel guesses
    // cannot share one attempt between them.
    const claimed = await this.prisma.authOtp.updateMany({
      where: {
        id: otp.id,
        consumedAt: null,
        attempts: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { ok: false, reason: "exhausted" };

    const expected = codeDigest(this.config.otpPepper, phoneNumber, code);
    if (digestsMatch(expected, otp.codeHmac)) {
      const consumed = await this.prisma.authOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: now },
      });
      // Lost to a parallel correct submission: that one signs in, not both.
      return consumed.count === 1
        ? { ok: true }
        : { ok: false, reason: "invalid" };
    }

    const attemptsLeft = OTP_MAX_ATTEMPTS - (otp.attempts + 1);
    if (attemptsLeft <= 0) {
      await this.prisma.authOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: now },
      });
      return { ok: false, reason: "exhausted" };
    }
    return { ok: false, reason: "invalid", attemptsLeft };
  }
}
