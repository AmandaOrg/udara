import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** The signed-in phones on an account. P9 adds listing and revoking. */
@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

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
