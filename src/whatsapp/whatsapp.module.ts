import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";
import { WhatsappSignatureGuard } from "./whatsapp-signature.guard";
import { WhatsappMessageService } from "./whatsapp-message.service";
import { WhatsappRouterService } from "./whatsapp-router.service";
import { AllowanceModule } from "../allowance/allowance.module";
import { RubiesModule } from "../rubies/rubies.module";
import { TaggingModule } from "../tagging/tagging.module";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { ManagerModule } from "../manager/manager.module";

@Module({
  imports: [
    HttpModule,
    AllowanceModule,
    // forwardRef: RubiesModule's webhook controller needs WhatsappService back —
    // see rubies.module.ts for the other half of this circular import.
    forwardRef(() => RubiesModule),
    TaggingModule,
    OnboardingModule,
    // forwardRef: ManagerModule's ManagerConversationService needs WhatsappService
    // back — see manager.module.ts for the other half of this circular import.
    forwardRef(() => ManagerModule),
  ],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappSignatureGuard,
    WhatsappMessageService,
    WhatsappRouterService,
  ],
  exports: [WhatsappService, WhatsappMessageService],
})
export class WhatsappModule {}
