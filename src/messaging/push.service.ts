import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { pushableDevices } from "./delivery-policy";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** A burst of messages (several bubbles, a result then a follow-up) is one alert. */
export const PUSH_COOLDOWN_MS = 60_000;

/**
 * What a push may say. Deliberately generic: a lock screen is readable by
 * anyone holding the phone, so a push never carries an amount, a name or an
 * account number. The message itself is in the app.
 */
export const PUSH_BODY = {
  transactional: "There's an update on your Udara account.",
  proactive: "Udara has a message for you.",
} as const;

interface ExpoTicket {
  status: "ok" | "error";
  details?: { error?: string };
}

/**
 * Push notifications through Expo's push service, which relays to APNs and
 * FCM. Best-effort: it never throws into the send that triggered it, because
 * the message itself is already in the app chat.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async notify(
    userId: string,
    delivery: keyof typeof PUSH_BODY,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      const devices = await this.prisma.device.findMany({
        where: pushableDevices(userId, now),
        select: { id: true, pushToken: true },
      });
      for (const device of devices) {
        if (!device.pushToken) continue;
        if (!(await this.claimCooldown(device.id, now))) continue;
        await this.send(device.id, device.pushToken, PUSH_BODY[delivery]);
      }
    } catch (err) {
      this.logger.warn(`push for user ${userId} failed: ${String(err)}`);
    }
  }

  /** Across replicas: only one sender gets the device per cooldown. */
  private async claimCooldown(deviceId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.device.updateMany({
      where: {
        id: deviceId,
        OR: [
          { lastPushAt: null },
          { lastPushAt: { lt: new Date(now.getTime() - PUSH_COOLDOWN_MS) } },
        ],
      },
      data: { lastPushAt: now },
    });
    return count === 1;
  }

  private async send(
    deviceId: string,
    pushToken: string,
    body: string,
  ): Promise<void> {
    if (this.config.get<string>("PUSH_DRY_RUN") === "true") {
      this.logger.log(`PUSH_DRY_RUN: push to device ${deviceId} not sent`);
      return;
    }

    const accessToken = this.config.get<string>("EXPO_ACCESS_TOKEN");
    const response = await firstValueFrom(
      this.http.post<{ data?: ExpoTicket[] }>(
        EXPO_PUSH_URL,
        [
          {
            to: pushToken,
            title: "Udara",
            body,
            sound: "default",
            data: { screen: "chat" },
          },
        ],
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
        },
      ),
    );

    const ticket = response.data?.data?.[0];
    if (ticket?.status === "error") {
      if (ticket.details?.error === "DeviceNotRegistered") {
        // The app was uninstalled or the token rotated. Conditional, so a
        // token registered again in the meantime is not wiped.
        await this.prisma.device.updateMany({
          where: { id: deviceId, pushToken },
          data: { pushToken: null },
        });
      }
      this.logger.warn(
        `push to device ${deviceId} rejected: ${ticket.details?.error ?? "unknown"}`,
      );
    }
  }
}
