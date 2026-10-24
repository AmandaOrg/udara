import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppAuthConfig } from "./app-auth.config";
import { newToken, tokenDigest } from "./secret-hash.util";

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Who an authenticated app request is from. */
export interface AppPrincipal {
  userId: string;
  deviceId: string;
  sessionId: string;
}

export type RefreshResult =
  | { ok: true; tokens: TokenPair }
  | { ok: false; reason: "invalid" | "reused" | "in_progress" };

/**
 * A client that fires two requests as its access token expires will send the
 * same refresh token twice. The second arrival inside this window is that race,
 * not theft, and is told to retry with the tokens the first one got.
 */
const REFRESH_REUSE_GRACE_MS = 30_000;
/** Activity stamps are for "last seen", not an audit log; once every few minutes is plenty. */
const TOUCH_EVERY_MS = 5 * 60_000;

/**
 * Opaque bearer sessions for the mobile app.
 *
 * Tokens are random and stored as SHA-256 digests (S16). Every request looks
 * its session up anyway (device revoked? user locked?), so a signed token
 * would save nothing and would make revocation harder.
 *
 * Refresh tokens rotate: each use retires the presented one and issues a
 * successor in the same family. Presenting a retired one again means two
 * parties hold it, so the whole family is revoked and both must sign in again.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppAuthConfig,
  ) {}

  async issue(
    userId: string,
    deviceId: string,
    familyId: string = randomUUID(),
    now: Date = new Date(),
  ): Promise<TokenPair> {
    const accessToken = newToken("udr_at");
    const refreshToken = newToken("udr_rt");
    const accessExpiresAt = new Date(now.getTime() + this.config.accessTtlMs);
    const refreshExpiresAt = new Date(now.getTime() + this.config.refreshTtlMs);
    await this.prisma.appSession.create({
      data: {
        userId,
        deviceId,
        familyId,
        accessHash: tokenDigest(accessToken),
        accessExpiresAt,
        refreshHash: tokenDigest(refreshToken),
        refreshExpiresAt,
      },
    });
    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt };
  }

  /** The principal behind a live access token, or null. Never throws on a bad token. */
  async authenticate(
    accessToken: string,
    now: Date = new Date(),
  ): Promise<AppPrincipal | null> {
    const session = await this.prisma.appSession.findUnique({
      where: { accessHash: tokenDigest(accessToken) },
      include: { device: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.rotatedAt ||
      session.accessExpiresAt <= now ||
      session.device.revokedAt ||
      !session.device.trustedAt
    ) {
      return null;
    }

    const lastSeen = session.device.lastSeenAt?.getTime() ?? 0;
    if (now.getTime() - lastSeen > TOUCH_EVERY_MS) {
      await this.prisma.device.update({
        where: { id: session.deviceId },
        data: { lastSeenAt: now },
      });
      // Never lastInboundMessageAt: that one decides Meta's 24-hour window.
      await this.prisma.user.update({
        where: { id: session.userId },
        data: { lastAppActiveAt: now },
      });
    }

    return {
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.id,
    };
  }

  async refresh(
    refreshToken: string,
    now: Date = new Date(),
  ): Promise<RefreshResult> {
    const session = await this.prisma.appSession.findUnique({
      where: { refreshHash: tokenDigest(refreshToken) },
      include: { device: true },
    });
    if (!session || session.revokedAt) return { ok: false, reason: "invalid" };

    if (session.rotatedAt) {
      if (
        now.getTime() - session.rotatedAt.getTime() <
        REFRESH_REUSE_GRACE_MS
      ) {
        return { ok: false, reason: "in_progress" };
      }
      await this.revokeFamily(session.familyId, now);
      this.logger.warn(
        `Retired refresh token presented again for user ${session.userId} — revoked session family ${session.familyId}`,
      );
      return { ok: false, reason: "reused" };
    }

    if (
      session.refreshExpiresAt <= now ||
      session.device.revokedAt ||
      !session.device.trustedAt
    ) {
      return { ok: false, reason: "invalid" };
    }

    // Retire it atomically: of two parallel refreshes, one gets the successor.
    const claimed = await this.prisma.appSession.updateMany({
      where: { id: session.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now },
    });
    if (claimed.count === 0) return { ok: false, reason: "in_progress" };

    const tokens = await this.issue(
      session.userId,
      session.deviceId,
      session.familyId,
      now,
    );
    return { ok: true, tokens };
  }

  /** Signs this session out, including every token rotated from it. */
  async logout(principal: AppPrincipal, now: Date = new Date()): Promise<void> {
    const session = await this.prisma.appSession.findUnique({
      where: { id: principal.sessionId },
    });
    if (session) await this.revokeFamily(session.familyId, now);
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.appSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
