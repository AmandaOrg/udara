import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { DeviceService } from "../../app-auth/device.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { PushTokenDto } from "./devices.dto";

/**
 * The phone the request comes from. Only ever the caller's own device: the id
 * is the session's, never taken from the request.
 */
@Controller("v1/devices")
export class DevicesController {
  constructor(private readonly devices: DeviceService) {}

  /** Called on every app start and whenever Expo rotates the token. */
  @Post("push-token")
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: PushTokenDto,
  ): Promise<void> {
    await this.devices.setPushToken(principal.deviceId, dto.pushToken);
  }

  /** Notifications turned off in the app. */
  @Delete("push-token")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(@CurrentPrincipal() principal: AppPrincipal): Promise<void> {
    await this.devices.clearPushToken(principal.deviceId);
  }
}
