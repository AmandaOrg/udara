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
import { AccountActionsService } from "./account-actions.service";
import { IntentRouterService } from "./intent-router.service";
import { PinGateService } from "./pin-gate.service";
import { WeeklyReviewService } from "./weekly-review.service";
import { WeeklyReviewScheduler } from "./weekly-review.scheduler";
import { DeepgramService } from "./deepgram.service";
import { EmailModule } from "../email/email.module";
import { ActionExecutorService } from "../orchestrator/action-executor.service";
import { OrchestratorModule } from "../orchestrator/orchestrator.module";
import { PinModule } from "../pin/pin.module";
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
    OrchestratorModule,
    PinModule,
    forwardRef(() => EmailModule),
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
    // Kept registered for existing unit specs; live router path no longer uses them.
    KeduChatService,
    AccountActionsService,
    IntentRouterService,
    PinGateService,
    // Needs WhatsApp/account deps — provided here, not in OrchestratorModule.
    ActionExecutorService,
    WeeklyReviewService,
    WeeklyReviewScheduler,
    DeepgramService,
  ],
  exports: [
    WhatsappService,
    WhatsappMessageService,
    TransferConfirmationService,
    ChunkedMessengerService,
  ],
})
export class WhatsappModule {}
