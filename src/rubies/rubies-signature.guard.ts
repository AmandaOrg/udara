import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { Request } from "express";

const MAX_CLOCK_SKEW_SECONDS = 300; // Rubies' documented replay-protection tolerance

/**
 * Set by the guard so the controller can record what actually happened rather
 * than asserting success. `RubiesWebhookEvent.signatureValid` previously
 * hardcoded `true`, which was a lie on the unsigned-local path and made the
 * audit trail claim every event had been verified.
 */
export interface SignatureCheckedRequest extends Request {
  rawBody?: Buffer;
  rubiesSignatureVerified?: boolean;
}

/**
 * Verifies Rubies' X-Webhook-Signature header — confirmed against the live
 * RubiesSme API docs (fetched during planning, not guessed):
 *
 *   X-Webhook-Signature: t=<unix ts>,v1=<hex hmac>
 *   signedPayload = "<t>.<raw request body>"
 *   expected v1 = HMAC-SHA256(RUBIES_SECRET_KEY, signedPayload), hex-encoded
 *
 * with a 5-minute timestamp tolerance against replay. Requires `rawBody:
 * true` on the Nest app (see main.ts) — the signature has to be computed
 * over the exact bytes Rubies sent.
 */
@Injectable()
export class RubiesSignatureGuard implements CanActivate {
  private readonly logger = new Logger(RubiesSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<SignatureCheckedRequest>();
    req.rubiesSignatureVerified = false;
    // RUBIES_SECRET_KEY doubles as the webhook signing secret (whsec_...) — see
    // the .env.example comment for why this reuses the existing var instead of
    // introducing a new one.
    const signingSecret = this.config.get<string>("RUBIES_SECRET_KEY");

    if (!signingSecret) {
      // Reachable only when ALLOW_UNSIGNED_WEBHOOKS=true: env validation refuses
      // to boot without this secret otherwise (see config/env.validation.ts), so
      // a production deploy can no longer land here by forgetting a variable.
      this.logger.warn(
        "RUBIES_SECRET_KEY is not set — accepting this webhook request WITHOUT signature verification.",
      );
      return true;
    }

    const header = req.headers["x-webhook-signature"];
    if (typeof header !== "string" || !req.rawBody) {
      throw new UnauthorizedException(
        "Missing X-Webhook-Signature header or raw request body",
      );
    }

    const parts: Record<string, string> = {};
    for (const part of header.split(",")) {
      const [key, value] = part.split("=");
      if (key && value !== undefined) parts[key] = value;
    }

    const timestamp = parts.t;
    const providedSignature = parts.v1;
    if (!timestamp || !providedSignature) {
      throw new UnauthorizedException("Malformed X-Webhook-Signature header");
    }

    const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(skewSeconds) || skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException(
        "X-Webhook-Signature timestamp is too old — possible replay",
      );
    }

    const signedPayload = `${timestamp}.${req.rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", signingSecret)
      .update(signedPayload)
      .digest("hex");

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(providedSignature);
    const valid =
      expectedBuf.length === providedBuf.length &&
      timingSafeEqual(expectedBuf, providedBuf);

    if (!valid) {
      throw new UnauthorizedException("Invalid X-Webhook-Signature");
    }

    req.rubiesSignatureVerified = true;
    return true;
  }
}
