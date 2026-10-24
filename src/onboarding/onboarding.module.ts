import { Module } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { AiModule } from "../ai/ai.module";
import { RubiesModule } from "../rubies/rubies.module";
import { MessagingModule } from "../messaging/messaging.module";

@Module({
  imports: [AiModule, RubiesModule, MessagingModule],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
