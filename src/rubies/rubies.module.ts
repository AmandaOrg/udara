import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { RubiesService } from "./rubies.service";
import { RubiesSignatureGuard } from "./rubies-signature.guard";
import { RubiesWebhookController } from "./rubies-webhook.controller";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { AllowanceModule } from "../allowance/allowance.module";
import { EmailModule } from "../email/email.module";
import { MessagingModule } from "../messaging/messaging.module";

@Module({
  // forwardRef: WhatsappModule already imports RubiesModule (for RubiesService),
  // and the inbound webhook controller here needs TransferConfirmationService and
  // BillPaymentConfirmationService (shared result resolution) back — forwardRef
  // breaks the circular resolution. Its credit messages go through MessagingModule.
  // AllowanceModule is pulled in the same way (it in turn imports WhatsappModule
  // too) so the webhook controller can read the daily/weekly figures for the
  // funded-celebration message.
  imports: [
    HttpModule.register({ timeout: 30_000, maxRedirects: 5 }),
    MessagingModule,
    forwardRef(() => WhatsappModule),
    forwardRef(() => AllowanceModule),
    // The webhook controller emails the user on an incoming credit.
    forwardRef(() => EmailModule),
  ],
  controllers: [RubiesWebhookController],
  providers: [RubiesService, RubiesSignatureGuard],
  exports: [RubiesService],
})
export class RubiesModule {}
