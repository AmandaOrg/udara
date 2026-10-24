import {
  codeDigest,
  digestsMatch,
  newSixDigitCode,
  newToken,
  tokenDigest,
} from "./secret-hash.util";

describe("secret-hash util", () => {
  it("makes distinct, prefixed tokens with no padding or unsafe characters", () => {
    const a = newToken("udr_at");
    const b = newToken("udr_at");

    expect(a).not.toBe(b);
    expect(a).toMatch(/^udr_at_[A-Za-z0-9_-]{43}$/);
  });

  it("stores a token as a digest that never contains the token", () => {
    const token = newToken("udr_rt");
    const digest = tokenDigest(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(tokenDigest(token)).toBe(digest);
  });

  it("draws 6-digit codes, keeping leading zeros", () => {
    for (let i = 0; i < 200; i++) {
      expect(newSixDigitCode()).toMatch(/^\d{6}$/);
    }
  });

  /**
   * The HMAC input includes the phone number: a code sent to one number must
   * never verify for another, even if both happen to draw the same digits.
   */
  it("binds a code to its phone number and to the pepper", () => {
    const base = codeDigest("pepper-1", "2348012345678", "123456");

    expect(codeDigest("pepper-1", "2348012345678", "123456")).toBe(base);
    expect(codeDigest("pepper-1", "2348099999999", "123456")).not.toBe(base);
    expect(codeDigest("pepper-2", "2348012345678", "123456")).not.toBe(base);
    expect(codeDigest("pepper-1", "2348012345678", "123457")).not.toBe(base);
  });

  it("compares digests in constant time and rejects different lengths", () => {
    const digest = tokenDigest("x");

    expect(digestsMatch(digest, tokenDigest("x"))).toBe(true);
    expect(digestsMatch(digest, tokenDigest("y"))).toBe(false);
    expect(digestsMatch(digest, digest.slice(0, 10))).toBe(false);
  });
});
