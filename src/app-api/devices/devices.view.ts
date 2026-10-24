import { ApiProperty } from "@nestjs/swagger";
import { Device, DevicePlatform } from "@prisma/client";

export const DEVICE_PLATFORMS = ["ios", "android"] as const;

export class DeviceView {
  id!: string;
  @ApiProperty({ enum: DEVICE_PLATFORMS })
  platform!: (typeof DEVICE_PLATFORMS)[number];
  /** What the phone called itself at sign-in, if anything. */
  name!: string | null;
  signedInAt!: string;
  lastSeenAt!: string | null;
  /** The phone making this request. */
  current!: boolean;
}

export class DeviceListView {
  devices!: DeviceView[];
}

export function toDeviceView(
  device: Device,
  currentDeviceId: string,
): DeviceView {
  return {
    id: device.id,
    platform: device.platform === DevicePlatform.IOS ? "ios" : "android",
    name: device.name,
    // Only trusted devices are listed, so trustedAt is set; createdAt is a
    // fallback that never changes the answer.
    signedInAt: (device.trustedAt ?? device.createdAt).toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    current: device.id === currentDeviceId,
  };
}
