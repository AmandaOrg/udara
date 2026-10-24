import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailNotificationsService } from "../email/email-notifications.service";
import { maskEmail } from "../email/mask-email.util";
import { AppAuthConfig } from "./app-auth.config";
import { codeDigest, digestsMatch, newSixDigitCode } from "./secret-hash.util";

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_AFTER_MS = 60_000;
export const EMAIL_CODE_MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

export type EmailCodeStartResult =
  | { ok: true; sentTo: string; expiresAt: Date; resendAfter: Date }
  | { ok: false; reason: "too_soon"; retryAfter: Date }
  | {
      ok: false;
      reason:
        | "no_email"
        | "already_verified"
        | "too_many_codes"
        | "email_unavailable";
    };

export type EmailCodeConfirmResult =
  | { ok: true }
  | { ok: false; reason: "invalid_code"; attemptsLeft?: number }
  | { ok: false; reason: "no_code" | "expired" | "exhausted" };

/**
 * What a code is bound to: this user and this address. A code sent before the
 * address changed can never verify the new one, and no code verifies for
 * anyone else. The prefix keeps these apart from sign-in codes, which are
 * bound to a phone number under the same pepper.
 */
function binding(userId: string, email: string): string {
  return `email:${userId}:${email}`;
}

/**
 * Proving the email address on file is the user's (P9): a 6-digit code to
 * that address, entered in the app.
 *
 * Stored only as an HMAC under the sign-in pepper (S16), with the same
 * expiry, attempt and resend limits as sign-in codes. Each email costs a
 * send, so the hourly cap matters as much as the attempt cap.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailNotifications: EmailNotificationsService,
    private readonly config: AppAuthConfig,
  ) {}

  async start(
    userId: string,
    now: Date = new Date(),
  ): Promise<EmailCodeStartResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.email) return { ok: false, reason: "no_email" };
    if (user.emailVerifiedAt) return { ok: false, reason: "already_verified" };

    const latest = await this.prisma.emailVerification.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (
      latest &&
      now.getTime() - latest.createdAt.getTime() < EMAIL_CODE_RESEND_AFTER_MS
    ) {
      return {
        ok: false,
        reason: "too_soon",
        retryAfter: new Date(
          latest.createdAt.getTime() + EMAIL_CODE_RESEND_AFTER_MS,
        ),
      };
    }
    const lastHour = await this.prisma.emailVerification.count({
      where: { userId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    });
    if (lastHour >= EMAIL_CODE_MAX_PER_HOUR) {
      return { ok: false, reason: "too_many_codes" };
    }

    // Only the newest code is ever valid.
    await this.prisma.emailVerification.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });

    const code = newSixDigitCode();
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
    const row = await this.prisma.emailVerification.create({
      data: {
        userId,
        email: user.email,
        codeHmac: codeDigest(
          this.config.otpPepper,
          binding(userId, user.email),
          code,
        ),
        expiresAt,
      },
    });

    const sent = await this.emailNotifications.sendEmailVerificationCode({
      user,
      code,
      verificationId: row.id,
      expiresInMinutes: EMAIL_CODE_TTL_MS / 60_000,
    });
    if (!sent) {
      await this.prisma.emailVerification.update({
        where: { id: row.id },
        data: { consumedAt: now },
      });
      this.logger.warn(`Email check code for user ${userId} was not sent`);
      return { ok: false, reason: "email_unavailable" };
    }

    return {
      ok: true,
      sentTo: maskEmail(user.email),
      expiresAt,
      resendAfter: new Date(now.getTime() + EMAIL_CODE_RESEND_AFTER_MS),
    };
  }

  async confirm(
    userId: string,
    code: string,
    now: Date = new Date(),
  ): Promise<EmailCodeConfirmResult> {
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid_code" };

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const row = await this.prisma.emailVerification.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // A code for an address that is no longer on file proves nothing.
    if (!row || !user.email || row.email !== user.email) {
      return { ok: false, reason: "no_code" };
    }
    if (row.expiresAt <= now) return { ok: false, reason: "expired" };

    // Claim the attempt before comparing, atomically, so parallel guesses
    // cannot share one attempt between them.
    const claimed = await this.prisma.emailVerification.updateMany({
      where: {
        id: row.id,
        consumedAt: null,
        attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { ok: false, reason: "exhausted" };

    const expected = codeDigest(
      this.config.otpPepper,
      binding(userId, row.email),
      code,
    );
    if (digestsMatch(expected, row.codeHmac)) {
      const consumed = await this.prisma.emailVerification.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return { ok: false, reason: "no_code" };
      // Only while the address is still the one the code went to.
      await this.prisma.user.updateMany({
        where: { id: userId, email: row.email },
        data: { emailVerifiedAt: now },
      });
      return { ok: true };
    }

    const attemptsLeft = EMAIL_CODE_MAX_ATTEMPTS - (row.attempts + 1);
    if (attemptsLeft <= 0) {
      await this.prisma.emailVerification.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      return { ok: false, reason: "exhausted" };
    }
    return { ok: false, reason: "invalid_code", attemptsLeft };
  }
}
