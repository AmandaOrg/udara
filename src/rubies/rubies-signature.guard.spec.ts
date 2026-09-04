import { UnauthorizedException } from "@nestjs/common";
import { createHmac } from "crypto";
import { RubiesSignatureGuard } from "./rubies-signature.guard";

/**
 * A forged Rubies callback can fabricate an incoming credit or flip a transfer
 * to succeeded, so this guard protects money state, not just an endpoint.
 * Header shape: `t=<unix ts>,v1=<hex hmac over "<t>.<raw body>">`.
 */
describe("RubiesSignatureGuard", () => {
  const secret = "whsec-test-secret";
  const rawBody = Buffer.from('{"drCr":"CR","amount":"5000"}');

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

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

  function makeGuard(signingSecret: string | undefined) {
    return new RubiesSignatureGuard({ get: () => signingSecret } as any);
  }

  function sign(
    body: Buffer,
    signingSecret: string,
    timestamp: number,
  ): string {
    const v1 = createHmac("sha256", signingSecret)
      .update(`${timestamp}.${body.toString("utf8")}`)
      .digest("hex");
    return `t=${timestamp},v1=${v1}`;
  }

  it("accepts a correctly signed, current payload", () => {
    const guard = makeGuard(secret);
    const context = makeContext({
      "x-webhook-signature": sign(rawBody, secret, nowSeconds()),
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const guard = makeGuard(secret);
    const context = makeContext({
      "x-webhook-signature": sign(rawBody, "attacker-secret", nowSeconds()),
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a valid signature replayed over different bytes", () => {
    const guard = makeGuard(secret);
    const context = makeContext(
      { "x-webhook-signature": sign(rawBody, secret, nowSeconds()) },
      Buffer.from('{"drCr":"CR","amount":"999999"}'),
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a correctly signed payload that is outside the replay window", () => {
    const guard = makeGuard(secret);
    const stale = nowSeconds() - 3600;
    const context = makeContext({
      "x-webhook-signature": sign(rawBody, secret, stale),
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a malformed header", () => {
    const guard = makeGuard(secret);

    expect(() =>
      guard.canActivate(makeContext({ "x-webhook-signature": "garbage" })),
    ).toThrow(UnauthorizedException);
  });

  it("rejects a header with no timestamp", () => {
    const guard = makeGuard(secret);
    const v1 = createHmac("sha256", secret)
      .update(rawBody.toString("utf8"))
      .digest("hex");

    expect(() =>
      guard.canActivate(makeContext({ "x-webhook-signature": `v1=${v1}` })),
    ).toThrow(UnauthorizedException);
  });

  it("rejects a missing signature header", () => {
    const guard = makeGuard(secret);

    expect(() => guard.canActivate(makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it("rejects when rawBody is absent", () => {
    const guard = makeGuard(secret);
    const context = makeContext(
      { "x-webhook-signature": sign(rawBody, secret, nowSeconds()) },
      null,
    );

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  // Documented dev-mode escape hatch, mirroring the WhatsApp guard. Reachable
  // only when ALLOW_UNSIGNED_WEBHOOKS=true, since env validation refuses to boot
  // with the secret blank otherwise.
  it("accepts unsigned requests when no signing secret is configured", () => {
    const guard = makeGuard(undefined);

    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  /**
   * RubiesWebhookEvent.signatureValid used to be hardcoded `true`, so every event
   * that came through the unsigned escape hatch was durably recorded as verified.
   * The controller now reads this flag, so the audit trail can distinguish a real
   * Rubies callback from anything else that reached the endpoint.
   */
  describe("records the verdict on the request", () => {
    function captureRequest(
      headers: Record<string, unknown>,
      body: Buffer | null = rawBody,
    ) {
      const req: Record<string, unknown> = { headers, rawBody: body };
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;
      return { req, context };
    }

    it("marks a verified request as verified", () => {
      const { req, context } = captureRequest({
        "x-webhook-signature": sign(rawBody, secret, nowSeconds()),
      });

      makeGuard(secret).canActivate(context);

      expect(req.rubiesSignatureVerified).toBe(true);
    });

    it("marks an unsigned request as NOT verified even though it is allowed", () => {
      const { req, context } = captureRequest({});

      expect(makeGuard(undefined).canActivate(context)).toBe(true);
      expect(req.rubiesSignatureVerified).toBe(false);
    });

    it("leaves the verdict false when the signature is rejected", () => {
      const { req, context } = captureRequest({
        "x-webhook-signature": sign(rawBody, "attacker-secret", nowSeconds()),
      });

      expect(() => makeGuard(secret).canActivate(context)).toThrow(
        UnauthorizedException,
      );
      expect(req.rubiesSignatureVerified).toBe(false);
    });
  });
});
