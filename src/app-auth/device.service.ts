import { Injectable } from "@nestjs/common";
import { Device } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** The signed-in phones on an account: listing, signing out, and push tokens. */
@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phones signed in to this account: trusted, not revoked, and holding a
   * session that can still be used or refreshed. A phone that signed out is
   * not listed, even though its row remains.
   */
  listSignedIn(userId: string, now: Date = new Date()): Promise<Device[]> {
    return this.prisma.device.findMany({
      where: {
        userId,
        trustedAt: { not: null },
        revokedAt: null,
        sessions: {
          some: { revokedAt: null, refreshExpiresAt: { gt: now } },
        },
      },
      orderBy: { trustedAt: "desc" },
    });
  }

  /**
   * Signs one of the user's phones out, from another or from itself: its
   * sessions end, and its pushes stop. False when it is not theirs, or was
   * already signed out. SessionService refuses a revoked device on the very
   * next request, whatever its tokens.
   */
  async revoke(
    userId: string,
    deviceId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const [device] = await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { id: deviceId, userId, revokedAt: null },
        data: { revokedAt: now, pushToken: null },
      }),
      // Scoped to the user as well, so a stranger's device id touches nothing.
      this.prisma.appSession.updateMany({
        where: { deviceId, userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return device.count === 1;
  }

  /**
   * Records where this device receives pushes. The token is taken off any
   * other device row first: when a phone is signed in as someone else, or
   * passed on, the previous account's alerts must stop arriving on it. The
   * unique index on `pushToken` holds the same line if two registrations race.
   */
  async setPushToken(deviceId: string, pushToken: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { pushToken, id: { not: deviceId } },
        data: { pushToken: null },
      }),
      this.prisma.device.update({
        where: { id: deviceId },
        data: { pushToken },
      }),
    ]);
  }

  async clearPushToken(deviceId: string): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { pushToken: null },
    });
  }
}
