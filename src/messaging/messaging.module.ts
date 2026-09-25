import { Module } from "@nestjs/common";
import { WhatsappTransportModule } from "../whatsapp/whatsapp-transport.module";
import { ChannelMessenger } from "./channel-messenger";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";

/**
 * Outbound messaging for domain modules. Depends only on transports, never on
 * a domain module, so anything may import it without a forwardRef.
 */
@Module({
  imports: [WhatsappTransportModule],
  providers: [ChannelMessenger, WhatsappChannelAdapter],
  exports: [ChannelMessenger],
})
export class MessagingModule {}
