import { UnauthorizedException } from "@nestjs/common";
import { createHmac } from "crypto";
import { WhatsappSignatureGuard } from "./whatsapp-signature.guard";

/**
 * This guard is the only thing standing between "Meta sent this" and "anyone
 * with the webhook URL sent this" — a forged inbound message drives the whole
 * bot. Covered here rather than only in e2e because e2e does not run in CI.
 */
describe("WhatsappSignatureGuard", () => {
  const appSecret = "test-app-secret";
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');

  function makeContext(
    headers: Record<string, unknown> = {},
    body: Buffer | null = rawBody,
  ) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers, rawBody: body }),
      }),
    } as any;
  }

  function makeGuard(secret: string | undefined) {
    return new WhatsappSignatureGuard({ get: () => secret } as any);
  }

  function sign(body: Buffer, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  it("accepts a correctly signed payload", () => {
    const guard = makeGuard(appSecret);
    const context = makeContext({
      "x-hub-signature-256": sign(rawBody, appSecret),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const guard = makeGuard(appSecret);
    const context = makeContext({
      "x-hub-signature-256": sign(rawBody, "attacker-secret"),
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a valid signature for different bytes", () => {
    const guard = makeGuard(appSecret);
    const context = makeContext(
      { "x-hub-signature-256": sign(rawBody, appSecret) },
      Buffer.from('{"object":"tampered"}'),
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a missing signature header", () => {
    const guard = makeGuard(appSecret);

    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it("rejects when rawBody is absent, since the digest cannot be trusted", () => {
    const guard = makeGuard(appSecret);
    const context = makeContext(
      { "x-hub-signature-256": sign(rawBody, appSecret) },
      null,
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a truncated signature rather than comparing a prefix", () => {
    const guard = makeGuard(appSecret);
    const full = sign(rawBody, appSecret);
    const context = makeContext({
      "x-hub-signature-256": full.slice(0, full.length - 4),
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  // Documented dev-mode escape hatch: unsigned requests are accepted only when
  // no secret is configured. Production must set WHATSAPP_APP_SECRET.
  it("accepts unsigned requests when no app secret is configured", () => {
    const guard = makeGuard(undefined);

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });
});
