import {
  randomBytes,
  randomUUID,
  scrypt,
  ScryptOptions,
  timingSafeEqual,
} from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { PinChallenge, PinChallengePurpose } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Hand-wrapped rather than promisify()'d: promisify resolves to scrypt's
 * 3-argument overload and silently drops the options parameter, which would
 * quietly downgrade every hash to Node's default work factors instead of the
 * ones configured below.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey),
    );
  });
}

/**
 * scrypt work factors. N is the memory/CPU cost; 16384 is the widely-cited
 * interactive baseline and keeps a single verification in the low tens of
 * milliseconds, which is irrelevant next to a WhatsApp round-trip. The
 * parameters are stored *inside* each hash string so they can be raised later
 * without invalidating existing PINs (verification reads the stored values,
 * not these constants).
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export const PIN_LENGTH = 4;

/**
 * Escalating lockout. This, not the KDF, is what actually protects a 4-digit
 * PIN: 10,000 candidates is trivially exhaustible offline, so the control
 * that matters is making online guessing expensive and bounded.
 */
const LOCKOUT_TIERS_MINUTES = [15, 60, 60 * 24];
const ATTEMPTS_PER_TIER = 3;

/**
 * PINs that a meaningful share of users would otherwise pick. Rejecting
 * these costs a few lines and removes the guesses an attacker would try
 * first, which matters a great deal when only three attempts are allowed
 * before lockout.
 */
const DENYLIST = new Set([
  "1234",
  "0000",
  "1111",
  "1212",
  "7777",
  "1004",
  "2000",
  "4444",
  "2222",
  "6969",
  "9999",
  "3333",
  "5555",
  "6666",
  "1122",
  "1313",
  "8888",
  "4321",
  "2001",
  "2580", // straight down the middle column of a keypad
]);

export type PinSetResult = { ok: true } | { ok: false; reason: string };

export type PinVerifyResult =
  { ok: true } | { ok: false; reason: string; lockedUntil?: Date };

/**
 * PIN lifecycle: setting, verifying, lockout, and the single-use challenges
 * that bind a PIN submission to one specific action.
 *
 * The PIN itself is never stored, never logged, and never persisted on the
 * WhatsappMessage row that carried it (see whatsapp/sensitive-fields.util.ts
 * for why that has to be enforced at the persistence boundary rather than
 * here).
 *
 * OPERATIONAL NOTE — there is deliberately no self-service PIN reset in v1.
 * A user who exhausts the lockout tiers, or who has genuinely forgotten
 * their PIN, needs manual intervention:
 *
 *   UPDATE "User"
 *      SET "pinHash" = NULL, "pinFailedAttempts" = 0, "pinLockedUntil" = NULL
 *    WHERE id = '<uuid>';
 *
 * That clears the PIN rather than setting a known one, so the user is
 * prompted to choose a fresh PIN on their next transfer and no operator ever
 * knows it. This is a documented procedure, not a workaround.
 */
@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Hashing
  // =========================================================================

  /** `scrypt$N$r$p$saltB64$hashB64` — self-describing so params can change later. */
  private async hashPin(pin: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scryptAsync(pin, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return [
      "scrypt",
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  /**
   * Constant-time comparison against a stored hash. Returns false rather
   * than throwing on a malformed/unknown-format hash: a corrupt record must
   * fail closed (nobody gets in), never fail open.
   */
  private async verifyAgainstHash(
    pin: string,
    stored: string,
  ): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      this.logger.error(
        "Stored pinHash is not in the expected scrypt format — failing closed",
      );
      return false;
    }

    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
      this.logger.error("Stored pinHash has non-numeric scrypt params");
      return false;
    }

    const expected = Buffer.from(hashB64, "base64");
    let derived: Buffer;
    try {
      derived = await scryptAsync(
        pin,
        Buffer.from(saltB64, "base64"),
        expected.length,
        { N, r, p },
      );
    } catch (err) {
      this.logger.error(`scrypt verification failed: ${String(err)}`);
      return false;
    }

    // Lengths are equal by construction (derived to expected.length), but
    // timingSafeEqual throws on a mismatch, so guard rather than risk it.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }

  // =========================================================================
  // Setting a PIN
  // =========================================================================

  /** Format + weakness rules. Exposed for direct unit testing. */
  validatePinStrength(pin: string, confirm?: string): PinSetResult {
    if (!/^\d{4}$/.test(pin)) {
      return { ok: false, reason: "your pin needs to be exactly 4 digits." };
    }
    if (confirm !== undefined && pin !== confirm) {
      return {
        ok: false,
        reason: "those two pins didn't match, let's try again.",
      };
    }
    if (new Set(pin).size === 1) {
      return {
        ok: false,
        reason:
          "that pin is too easy to guess, don't use the same digit four times.",
      };
    }
    if (isSequential(pin)) {
      return {
        ok: false,
        reason: "that pin is too easy to guess, don't use digits in a row.",
      };
    }
    if (DENYLIST.has(pin)) {
      return {
        ok: false,
        reason:
          "that's one of the most common pins there is, pick something else.",
      };
    }
    return { ok: true };
  }

  /** Validates, hashes, stores, and clears any prior lockout state. */
  async setPin(
    userId: string,
    pin: string,
    confirm?: string,
  ): Promise<PinSetResult> {
    const strength = this.validatePinStrength(pin, confirm);
    if (!strength.ok) return strength;

    const pinHash = await this.hashPin(pin);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pinHash,
        pinSetAt: new Date(),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
    return { ok: true };
  }

  // =========================================================================
  // Verifying, with lockout
  // =========================================================================

  /** True if the user is currently locked out. */
  isLocked(
    user: { pinLockedUntil: Date | null },
    now: Date = new Date(),
  ): boolean {
    return user.pinLockedUntil !== null && user.pinLockedUntil > now;
  }

  /**
   * Verifies a submitted PIN, applying lockout on failure and resetting the
   * counter on success. Every failure path increments atomically, so
   * concurrent submissions cannot be used to get extra free guesses.
   */
  async verifyPin(
    userId: string,
    pin: string,
    now: Date = new Date(),
  ): Promise<PinVerifyResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (!user.pinHash) {
      return { ok: false, reason: "you haven't set a pin yet." };
    }

    if (this.isLocked(user, now)) {
      return {
        ok: false,
        reason: "too many wrong attempts, your pin is locked right now.",
        lockedUntil: user.pinLockedUntil ?? undefined,
      };
    }

    const matches = await this.verifyAgainstHash(pin, user.pinHash);

    if (matches) {
      // Only clear state if there was any, to avoid a pointless write on the
      // overwhelmingly common happy path.
      if (user.pinFailedAttempts !== 0 || user.pinLockedUntil !== null) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { pinFailedAttempts: 0, pinLockedUntil: null },
        });
      }
      return { ok: true };
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: { increment: 1 } },
    });

    const lockUntil = computeLockout(updated.pinFailedAttempts, now);
    if (lockUntil) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { pinLockedUntil: lockUntil },
      });
      this.logger.warn(
        `User ${userId} locked out after ${updated.pinFailedAttempts} failed PIN attempts, until ${lockUntil.toISOString()}`,
      );
      return {
        ok: false,
        reason: "too many wrong attempts, your pin is locked.",
        lockedUntil: lockUntil,
      };
    }

    const remaining =
      ATTEMPTS_PER_TIER - (updated.pinFailedAttempts % ATTEMPTS_PER_TIER);
    return {
      ok: false,
      reason: `that pin isn't right. ${remaining} ${remaining === 1 ? "try" : "tries"} left before it locks.`,
    };
  }

  // =========================================================================
  // Single-use challenges
  // =========================================================================

  /**
   * Creates a challenge bound to one action, returning the flowToken to send
   * with the Flow. Five minutes is deliberately short: the token is the only
   * thing tying a PIN submission to a specific transfer.
   */
  async createChallenge(params: {
    userId: string;
    purpose: PinChallengePurpose;
    transactionId?: string;
    ttlMs?: number;
    now?: Date;
  }): Promise<PinChallenge> {
    const now = params.now ?? new Date();
    return this.prisma.pinChallenge.create({
      data: {
        userId: params.userId,
        purpose: params.purpose,
        transactionId: params.transactionId,
        flowToken: randomUUID(),
        expiresAt: new Date(now.getTime() + (params.ttlMs ?? 5 * 60 * 1000)),
      },
    });
  }

  /**
   * Resolves a returned flowToken to its challenge and consumes it in the
   * same step. The consuming update is conditional on `consumedAt` still
   * being null, so two concurrent replies with the same token cannot both
   * succeed — the second matches zero rows and is rejected as a replay.
   *
   * Rejects a token that is unknown, expired, already used, or owned by a
   * different user than the one who sent the message.
   */
  async consumeChallenge(
    flowToken: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<PinChallenge | null> {
    const challenge = await this.prisma.pinChallenge.findUnique({
      where: { flowToken },
    });
    if (!challenge) {
      this.logger.warn(
        `PIN challenge not found for flowToken (user ${userId})`,
      );
      return null;
    }
    if (challenge.userId !== userId) {
      this.logger.error(
        `PIN challenge ${challenge.id} belongs to user ${challenge.userId}, not ${userId} — rejecting`,
      );
      return null;
    }
    if (challenge.consumedAt) {
      this.logger.warn(
        `PIN challenge ${challenge.id} already consumed — replay rejected`,
      );
      return null;
    }
    if (challenge.expiresAt <= now) {
      this.logger.warn(`PIN challenge ${challenge.id} expired`);
      return null;
    }

    const { count } = await this.prisma.pinChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (count === 0) {
      this.logger.warn(
        `PIN challenge ${challenge.id} was consumed concurrently — replay rejected`,
      );
      return null;
    }

    return challenge;
  }
}

/** 1234 / 4321 and any other straight run, ascending or descending. */
function isSequential(pin: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < pin.length; i += 1) {
    const delta = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Returns the lock expiry once a tier boundary is crossed, or null if the
 * user still has attempts left in the current tier. Tiers escalate and then
 * hold at the longest one rather than growing without bound.
 */
function computeLockout(failedAttempts: number, now: Date): Date | null {
  if (failedAttempts % ATTEMPTS_PER_TIER !== 0) return null;
  const tierIndex = Math.min(
    failedAttempts / ATTEMPTS_PER_TIER - 1,
    LOCKOUT_TIERS_MINUTES.length - 1,
  );
  const minutes = LOCKOUT_TIERS_MINUTES[tierIndex];
  return new Date(now.getTime() + minutes * 60 * 1000);
}
