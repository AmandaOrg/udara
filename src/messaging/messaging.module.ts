import { Module } from "@nestjs/common";
import { WhatsappTransportModule } from "../whatsapp/whatsapp-transport.module";
import { ChannelMessenger } from "./channel-messenger";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";
import { AppChannelAdapter } from "./app-channel.adapter";
import { AppMessageService } from "./app-message.service";
import { AppMessageNotifier } from "./app-message.notifier";

/**
 * Outbound messaging for domain modules. Depends only on transports (the
 * WhatsApp Cloud API, and the database for the in-app chat), never on a domain
 * module, so anything may import it without a forwardRef.
 */
@Module({
  imports: [WhatsappTransportModule],
  providers: [
    ChannelMessenger,
    WhatsappChannelAdapter,
    AppChannelAdapter,
    AppMessageService,
    AppMessageNotifier,
  ],
  exports: [ChannelMessenger, AppMessageService, AppMessageNotifier],
})
export class MessagingModule {}
