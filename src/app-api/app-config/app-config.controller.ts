import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "../public.decorator";
import { AppConfigView } from "./app-config.view";

/**
 * Read before sign-in, so it is public (S14 allows it in this file). It holds
 * nothing about any user.
 */
@Controller("v1/app-config")
export class AppConfigController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  get(): AppConfigView {
    const version = this.config
      .get<string>("APP_MIN_SUPPORTED_VERSION")
      ?.trim();
    return { minSupportedVersion: version ? version : null };
  }
}
