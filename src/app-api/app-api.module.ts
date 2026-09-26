import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppAuthModule } from "../app-auth/app-auth.module";
import { MessagingModule } from "../messaging/messaging.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { AppAuthGuard } from "./app-auth.guard";
import { AuthController } from "./auth/auth.controller";
import { MeController } from "./me/me.controller";
import { ChatController } from "./chat/chat.controller";
import { FormsController } from "./chat/forms.controller";
import { DevicesController } from "./devices/devices.controller";
import { AppConversationService } from "./chat/app-conversation.service";

/**
 * The mobile app's HTTP API under /v1. Loaded only when APP_API_ENABLED=true
 * (see app.module.ts), so these routes do not exist until they are switched on.
 *
 * AppAuthGuard is global and denies every /v1 route without a live session
 * unless the handler is @Public() (S14).
 */
@Module({
  imports: [
    AppAuthModule,
    MessagingModule,
    // The conversation engine, the turn lease and the shared rate limit.
    WhatsappModule,
    OnboardingModule,
  ],
  controllers: [
    AuthController,
    MeController,
    ChatController,
    FormsController,
    DevicesController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppAuthGuard },
    AppConversationService,
  ],
})
export class AppApiModule {}
