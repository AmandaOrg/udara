import { forwardRef, Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { RubiesService } from "./rubies.service";
import { RubiesSignatureGuard } from "./rubies-signature.guard";
import { RubiesWebhookController } from "./rubies-webhook.controller";
import { AllowanceModule } from "../allowance/allowance.module";
import { WhatsappModule } from "../whatsapp/whatsapp.module";

@Module({
  // forwardRef: WhatsappModule already imports RubiesModule (for RubiesService),
  // and the inbound webhook controller here needs WhatsappService (PRD §4a's
  // incoming-funds confirmation) — forwardRef breaks the circular resolution.
  imports: [HttpModule, AllowanceModule, forwardRef(() => WhatsappModule)],
  controllers: [RubiesWebhookController],
  providers: [RubiesService, RubiesSignatureGuard],
  exports: [RubiesService],
})
export class RubiesModule {}
