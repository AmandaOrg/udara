import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";
import { AllowanceModule } from "../allowance/allowance.module";
import { RubiesModule } from "../rubies/rubies.module";
import { TaggingModule } from "../tagging/tagging.module";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { ManagerModule } from "../manager/manager.module";

@Module({
  imports: [
    HttpModule,
    AllowanceModule,
    RubiesModule,
    TaggingModule,
    OnboardingModule,
    ManagerModule,
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService],
})
export class WhatsappModule {}
