import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { tokenDigest } from "../app-auth/secret-hash.util";

/**
 * The global rate limit, counted per app session where there is one and per
 * client address otherwise.
 *
 * Address alone is the wrong key for the app: Nigerian carriers put many
 * phones behind one public address, so an address-keyed limit would have
 * strangers throttling each other. Keying on a digest of the bearer token
 * separates them without waiting for authentication, which may run after this
 * guard. Webhooks carry no bearer token and keep the address key.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>,
  ): Promise<string> {
    const header = req.headers?.authorization;
    const match =
      typeof header === "string"
        ? /^Bearer\s+(\S+)$/i.exec(header.trim())
        : null;
    if (match) return `session:${tokenDigest(match[1]).slice(0, 32)}`;
    return req.ip;
  }
}
