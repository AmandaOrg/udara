import { Matches, MaxLength } from "class-validator";

export class PushTokenDto {
  /** An Expo push token, as `Notifications.getExpoPushTokenAsync` returns it. */
  @MaxLength(200)
  @Matches(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/)
  pushToken!: string;
}
