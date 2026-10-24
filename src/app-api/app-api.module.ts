import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppAuthModule } from "../app-auth/app-auth.module";
import { MessagingModule } from "../messaging/messaging.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { RubiesModule } from "../rubies/rubies.module";
import { AllowanceModule } from "../allowance/allowance.module";
import { TaggingModule } from "../tagging/tagging.module";
import { AppAuthGuard } from "./app-auth.guard";
import { AuthController } from "./auth/auth.controller";
import { MeController } from "./me/me.controller";
import { ChatController } from "./chat/chat.controller";
import { FormsController } from "./chat/forms.controller";
import { DevicesController } from "./devices/devices.controller";
import { AppConversationService } from "./chat/app-conversation.service";
import { AccountController } from "./account/account.controller";
import { AccountOverviewService } from "./account/account-overview.service";
import { HistoryController } from "./history/history.controller";
import { TransactionHistoryService } from "./history/transaction-history.service";
import { RecipientsController } from "./recipients/recipients.controller";
import { BanksController } from "./banks/banks.controller";
import { BankDirectoryService } from "./banks/bank-directory.service";
import { NameEnquiryService } from "./banks/name-enquiry.service";
import { BillsController } from "./bills/bills.controller";
import { AppConfigController } from "./app-config/app-config.controller";
import { TransfersController } from "./transfers/transfers.controller";
import { NativeTransferService } from "./transfers/native-transfer.service";
import { NativeBillService } from "./bills/native-bill.service";
import { ManagerModule } from "../manager/manager.module";
import { PinModule } from "../pin/pin.module";
import { AccountClosureModule } from "../account-closure/account-closure.module";
import { SettingsRequestsController } from "./settings-requests/settings-requests.controller";
import { AccountDeletionController } from "./account/account-deletion.controller";
import { EmailVerificationController } from "./email/email-verification.controller";
import { TermsController } from "./terms/terms.controller";

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
    // The read-only screens (P6).
    RubiesModule,
    AllowanceModule,
    TaggingModule,
    // Account and compliance (P9).
    ManagerModule,
    PinModule,
    AccountClosureModule,
  ],
  controllers: [
    AuthController,
    MeController,
    ChatController,
    FormsController,
    DevicesController,
    AccountController,
    HistoryController,
    RecipientsController,
    BanksController,
    BillsController,
    AppConfigController,
    TransfersController,
    SettingsRequestsController,
    AccountDeletionController,
    EmailVerificationController,
    TermsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AppAuthGuard },
    AppConversationService,
    AccountOverviewService,
    TransactionHistoryService,
    BankDirectoryService,
    NameEnquiryService,
    NativeTransferService,
    NativeBillService,
  ],
})
export class AppApiModule {}
