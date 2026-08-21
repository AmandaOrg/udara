import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { RubiesService } from "./rubies.service";
import { RubiesSignatureGuard } from "./rubies-signature.guard";
import { RubiesWebhookController } from "./rubies-webhook.controller";
import { WhatsappModule } from "../whatsapp/whatsapp.module";
import { AllowanceModule } from "../allowance/allowance.module";

@Module({
  // forwardRef: WhatsappModule already imports RubiesModule (for RubiesService),
  // and the inbound webhook controller here needs WhatsappService (PRD §4a's
  // incoming-funds confirmation) and TransferConfirmationService (shared
  // transfer-status resolution) back — forwardRef breaks the circular resolution.
  // AllowanceModule is pulled in the same way (it in turn imports WhatsappModule
  // too) so the webhook controller can read the daily/weekly figures for the
  // funded-celebration message.
  imports: [
    HttpModule,
    forwardRef(() => WhatsappModule),
    forwardRef(() => AllowanceModule),
  ],
  controllers: [RubiesWebhookController],
  providers: [RubiesService, RubiesSignatureGuard],
  exports: [RubiesService],
})
export class RubiesModule {}
