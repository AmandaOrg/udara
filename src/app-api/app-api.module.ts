import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppAuthModule } from "../app-auth/app-auth.module";
import { AppAuthGuard } from "./app-auth.guard";
import { AuthController } from "./auth/auth.controller";
import { MeController } from "./me/me.controller";

/**
 * The mobile app's HTTP API under /v1. Loaded only when APP_API_ENABLED=true
 * (see app.module.ts), so these routes do not exist until they are switched on.
 *
 * AppAuthGuard is global and denies every /v1 route without a live session
 * unless the handler is @Public() (S14).
 */
@Module({
  imports: [AppAuthModule],
  controllers: [AuthController, MeController],
  providers: [{ provide: APP_GUARD, useClass: AppAuthGuard }],
})
export class AppApiModule {}
