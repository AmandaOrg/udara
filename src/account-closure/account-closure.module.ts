import { Module } from "@nestjs/common";
import { RubiesModule } from "../rubies/rubies.module";
import { ManagerModule } from "../manager/manager.module";
import { MessagingModule } from "../messaging/messaging.module";
import { EmailModule } from "../email/email.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { AccountClosureService } from "./account-closure.service";

/**
 * Closing an account (ADR-0003). Imported by AppModule, so the ops CLI can
 * reach it with the app API switched off, and by AppApiModule for the app's
 * request route. WhatsappModule is here for the turn lease.
 */
@Module({
  imports: [
    RubiesModule,
    ManagerModule,
    MessagingModule,
    EmailModule,
    WhatsappModule,
  ],
  providers: [AccountClosureService],
  exports: [AccountClosureService],
})
export class AccountClosureModule {}
