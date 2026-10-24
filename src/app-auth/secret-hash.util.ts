import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/**
 * The only ways app sign-in secrets are made and stored (S16). The plaintext
 * of a code or token exists in memory while it is handed to the user, and
 * nowhere else: the database keeps these digests.
 */

/**
 * An opaque bearer token. 32 random bytes is beyond guessing, which is why a
 * fast hash is enough to store it: there is no small keyspace to walk. The
 * prefix makes a leaked token recognisable to secret scanners.
 */
export function newToken(prefix: "udr_at" | "udr_rt" | "udr_lc"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Storage digest for a high-entropy token. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A 6-digit one-time code, uniformly drawn. */
export function newSixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Storage digest for a low-entropy code. Keyed with a server-side pepper so a
 * copy of the table alone cannot be walked through all million codes, and
 * bound to the phone number so a code issued to one number never verifies
 * for another.
 */
export function codeDigest(
  pepper: string,
  phoneNumber: string,
  code: string,
): string {
  return createHmac("sha256", pepper)
    .update(`${phoneNumber}:${code}`, "utf8")
    .digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
