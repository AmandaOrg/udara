import { forwardRef, Module } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { AiModule } from "../ai/ai.module";
import { RubiesModule } from "../rubies/rubies.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";

@Module({
  imports: [
    AiModule,
    RubiesModule,
    // forwardRef: WhatsappModule already imports OnboardingModule (for OnboardingService),
    // and OnboardingService needs WhatsappService/ChunkedMessengerService back — same
    // circular pattern as Rubies/Manager/Allowance, resolved the same way.
    forwardRef(() => WhatsappModule),
  ],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
