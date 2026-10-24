import { Injectable } from "@nestjs/common";
import { BillPaymentStatus, TransactionStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppAuthConfig } from "./app-auth.config";

/** How long a newly trusted device stays capped. */
export const NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type NewDeviceCapVerdict =
  { ok: true } | { ok: false; cap: number; remaining: number; liftsAt: Date };

/**
 * The limit on what a phone can move in its first day (ADR-0002).
 *
 * Sign-in step-up stops someone with only a swapped SIM. It cannot stop
 * someone who also has the PIN, and a device-bound key does not exist yet, so
 * the backstop is to keep the first day's losses small while the owner gets
 * the new-device alerts on WhatsApp and email.
 *
 * Counts everything the user has sent on any channel since the device was
 * trusted, not only what this device sent. That is stricter, and it needs no
 * device column on transactions.
 */
@Injectable()
export class NewDeviceCapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppAuthConfig,
  ) {}

  async check(
    userId: string,
    deviceId: string,
    amount: number,
    now: Date = new Date(),
  ): Promise<NewDeviceCapVerdict> {
    const cap = this.config.newDeviceTransferCap;
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
    });
    if (!device?.trustedAt) {
      // A request with a session always has a trusted device, so this is a
      // wiring mistake. Money is the wrong place to guess.
      return {
        ok: false,
        cap,
        remaining: 0,
        liftsAt: new Date(now.getTime() + NEW_DEVICE_WINDOW_MS),
      };
    }

    const liftsAt = new Date(device.trustedAt.getTime() + NEW_DEVICE_WINDOW_MS);
    if (now >= liftsAt) return { ok: true };

    const since = device.trustedAt;
    const [transfers, bills] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: {
          userId,
          status: {
            in: [TransactionStatus.CONFIRMED, TransactionStatus.EXECUTED],
          },
          confirmedAt: { gte: since },
        },
        _sum: { amount: true },
      }),
      this.prisma.billPayment.aggregate({
        where: {
          userId,
          status: {
            in: [BillPaymentStatus.CONFIRMED, BillPaymentStatus.EXECUTED],
          },
          confirmedAt: { gte: since },
        },
        _sum: { amount: true },
      }),
    ]);
    const sent =
      Number(transfers._sum.amount ?? 0) + Number(bills._sum.amount ?? 0);
    const remaining = Math.max(0, cap - sent);
    if (amount <= remaining) return { ok: true };
    return { ok: false, cap, remaining, liftsAt };
  }
}
