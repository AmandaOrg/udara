import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "./prisma/prisma.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { RubiesModule } from "./rubies/rubies.module";
import { AllowanceModule } from "./allowance/allowance.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { TaggingModule } from "./tagging/tagging.module";
import { ManagerModule } from "./manager/manager.module";
import { validate } from "./config/env.validation";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RubiesModule,
    AllowanceModule,
    TaggingModule,
    OnboardingModule,
    ManagerModule,
    WhatsappModule, // depends on the modules above — keep last
  ],
})
export class AppModule {}
