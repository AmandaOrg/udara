import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { DeviceService } from "../../app-auth/device.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { PushTokenDto } from "./devices.dto";
import { DeviceListView, toDeviceView } from "./devices.view";

/**
 * The phones signed in to the caller's account. The push-token routes act on
 * the phone the request comes from (the session's device, never the
 * request's); listing and signing out (P9) cover all of the caller's phones
 * and nobody else's.
 *
 * The push-token routes are declared first and must stay so: Express matches
 * in registration order, and `DELETE push-token` must never reach `:id`.
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

  @Get()
  async list(
    @CurrentPrincipal() principal: AppPrincipal,
  ): Promise<DeviceListView> {
    const devices = await this.devices.listSignedIn(principal.userId);
    return {
      devices: devices.map((device) =>
        toDeviceView(device, principal.deviceId),
      ),
    };
  }

  /** Signs that phone out. The phone in hand may sign itself out this way too. */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    if (!(await this.devices.revoke(principal.userId, id))) {
      throw new NotFoundException({ error: "not_found" });
    }
  }
}
