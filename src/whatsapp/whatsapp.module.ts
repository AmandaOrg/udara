import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";
import { WhatsappSignatureGuard } from "./whatsapp-signature.guard";
import { WhatsappMessageService } from "./whatsapp-message.service";
import { WhatsappRouterService } from "./whatsapp-router.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { TransferReconciliationScheduler } from "./transfer-reconciliation.scheduler";
import { ChunkedMessengerService } from "./chunked-messenger.service";
import { KeduChatService } from "./kedu-chat.service";
import { AllowanceModule } from "../allowance/allowance.module";
import { RubiesModule } from "../rubies/rubies.module";
import { TaggingModule } from "../tagging/tagging.module";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { ManagerModule } from "../manager/manager.module";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [
    HttpModule,
    AiModule,
    // forwardRef: AllowanceModule's AllowanceScheduler needs WhatsappService back
    // (window-open nudge, Phase 9) — see allowance.module.ts for the other half.
    forwardRef(() => AllowanceModule),
    // forwardRef: RubiesModule's webhook controller needs WhatsappService back —
    // see rubies.module.ts for the other half of this circular import.
    forwardRef(() => RubiesModule),
    TaggingModule,
    // forwardRef: OnboardingModule's OnboardingService needs WhatsappService/
    // ChunkedMessengerService back — see onboarding.module.ts for the other half.
    forwardRef(() => OnboardingModule),
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
    TransferConfirmationService,
    TransferReconciliationScheduler,
    ChunkedMessengerService,
    KeduChatService,
  ],
  exports: [
    WhatsappService,
    WhatsappMessageService,
    TransferConfirmationService,
    ChunkedMessengerService,
  ],
})
export class WhatsappModule {}
