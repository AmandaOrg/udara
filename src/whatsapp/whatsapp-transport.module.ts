import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappService } from "./whatsapp.service";
import { WhatsappMessageService } from "./whatsapp-message.service";
import { ChunkedMessengerService } from "./chunked-messenger.service";

/**
 * The WhatsApp Cloud API itself: sending, and recording what was sent and
 * received. No domain logic, so nothing here needs a domain module back,
 * which is what used to force every domain module into a forwardRef with
 * WhatsappModule.
 */
@Module({
  imports: [HttpModule.register({ timeout: 30_000, maxRedirects: 5 })],
  providers: [WhatsappService, WhatsappMessageService, ChunkedMessengerService],
  exports: [WhatsappService, WhatsappMessageService, ChunkedMessengerService],
})
export class WhatsappTransportModule {}
