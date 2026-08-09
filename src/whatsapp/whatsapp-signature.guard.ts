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

/**
 * Verifies Meta's X-Hub-Signature-256 header on inbound WhatsApp webhook
 * requests — HMAC-SHA256 over the raw request body, keyed by the Meta App
 * Secret. This is the actual answer to "how do we know a message really came
 * from Meta / this number," not just a nice-to-have.
 *
 * Requires `rawBody: true` on the Nest app (see main.ts) so `req.rawBody`
 * holds the exact bytes Meta sent — signing over a re-serialized JSON object
 * would produce a different, non-matching digest.
 */
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    const appSecret = this.config.get<string>("WHATSAPP_APP_SECRET");

    if (!appSecret) {
      // Dev-mode escape hatch: no real Meta App Secret configured yet (this is a
      // personal-tool scaffold, not a production deployment). Loudly logged so this
      // is never silently insecure — set WHATSAPP_APP_SECRET before going live.
      this.logger.warn(
        "WHATSAPP_APP_SECRET is not set — accepting this webhook request WITHOUT signature verification.",
      );
      return true;
    }

    const signatureHeader = req.headers["x-hub-signature-256"];
    if (typeof signatureHeader !== "string" || !req.rawBody) {
      throw new UnauthorizedException(
        "Missing X-Hub-Signature-256 header or raw request body",
      );
    }

    const expected =
      "sha256=" +
      createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(signatureHeader);

    const valid =
      expectedBuf.length === providedBuf.length &&
      timingSafeEqual(expectedBuf, providedBuf);

    if (!valid) {
      throw new UnauthorizedException("Invalid X-Hub-Signature-256");
    }

    return true;
  }
}
