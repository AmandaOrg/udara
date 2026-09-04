import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { HealthModule } from "./health/health.module";
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
    // Gated so the CLI tools, which boot this same module to reach its
    // providers, do not also start every cron. Running the monthly-resend CLI on
    // an operator's laptop turned that laptop into a second replica for as long
    // as it was open: the every-minute reconciliation and the managers' reply
    // job fired from there, against production.
    ...(process.env.DISABLE_SCHEDULERS === "true"
      ? []
      : [ScheduleModule.forRoot()]),
    // Edge-level flood protection. Deliberately generous: Meta batches inbound
    // messages and legitimate bursts are real, so this is a ceiling on abuse,
    // not a per-user budget. The per-user cost cap that stops one hostile number
    // burning LLM and speech-to-text spend lives in the router, where the user is
    // actually known — every Meta webhook arrives from Meta's own IPs, so an
    // IP-keyed limit cannot tell customers apart.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    HealthModule,
    PrismaModule,
    RubiesModule,
    AllowanceModule,
    TaggingModule,
    OnboardingModule,
    ManagerModule,
    WhatsappModule, // depends on the modules above — keep last
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
