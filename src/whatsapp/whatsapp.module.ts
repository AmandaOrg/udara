import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappSignatureGuard } from "./whatsapp-signature.guard";
import { WhatsappRouterService } from "./whatsapp-router.service";
import { BillPaymentActionsService } from "./bill-payment-actions.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import { TransferReconciliationScheduler } from "./transfer-reconciliation.scheduler";
import { AccountActionsService } from "./account-actions.service";
import { PinGateService } from "./pin-gate.service";
import { PinOutcomeService } from "./pin-outcome.service";
import { WeeklyReviewService } from "./weekly-review.service";
import { WeeklyReviewScheduler } from "./weekly-review.scheduler";
import { DeepgramService } from "./deepgram.service";
import { InboundRateLimitService } from "./inbound-rate-limit.service";
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
import { MessagingModule } from "../messaging/messaging.module";
import { WhatsappTransportModule } from "./whatsapp-transport.module";

@Module({
  imports: [
    // DeepgramService's HTTP client; the Cloud API's lives in the transport.
    HttpModule.register({ timeout: 30_000, maxRedirects: 5 }),
    WhatsappTransportModule,
    MessagingModule,
    AiModule,
    OrchestratorModule,
    PinModule,
    forwardRef(() => EmailModule),
    forwardRef(() => AllowanceModule),
    // forwardRef: RubiesModule's webhook controller needs the confirmation
    // services back — see rubies.module.ts for the other half of this cycle.
    forwardRef(() => RubiesModule),
    TaggingModule,
    // Onboarding, Manager and Allowance no longer import this module (they send
    // through MessagingModule), but their files still reach this one through
    // RubiesModule's imports, so the forwardRef keeps load order irrelevant.
    forwardRef(() => OnboardingModule),
    forwardRef(() => ManagerModule),
  ],
  controllers: [WhatsappController],
  providers: [
    WhatsappSignatureGuard,
    WhatsappRouterService,
    TransferConfirmationService,
    BillPaymentActionsService,
    BillPaymentConfirmationService,
    TransferReconciliationScheduler,
    AccountActionsService,
    PinGateService,
    PinOutcomeService,
    // Needs WhatsApp/account deps — provided here, not in OrchestratorModule.
    ActionExecutorService,
    WeeklyReviewService,
    WeeklyReviewScheduler,
    DeepgramService,
    InboundRateLimitService,
  ],
  exports: [
    WhatsappTransportModule,
    TransferConfirmationService,
    BillPaymentConfirmationService,
  ],
})
export class WhatsappModule {}
