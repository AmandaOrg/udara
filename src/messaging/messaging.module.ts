import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { WhatsappTransportModule } from "../whatsapp/whatsapp-transport.module";
import { ChannelMessenger } from "./channel-messenger";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";
import { AppChannelAdapter } from "./app-channel.adapter";
import { AppMessageService } from "./app-message.service";
import { AppMessageNotifier } from "./app-message.notifier";
import { DeliveryPolicyService } from "./delivery-policy";
import { PushService } from "./push.service";

/**
 * Outbound messaging for domain modules. Depends only on transports (the
 * WhatsApp Cloud API, the database for the in-app chat, Expo for push), never
 * on a domain module, so anything may import it without a forwardRef.
 */
@Module({
  imports: [
    WhatsappTransportModule,
    // Expo push. A hung push must not hold up the send that triggered it.
    HttpModule.register({ timeout: 10_000, maxRedirects: 0 }),
  ],
  providers: [
    ChannelMessenger,
    WhatsappChannelAdapter,
    AppChannelAdapter,
    AppMessageService,
    AppMessageNotifier,
    DeliveryPolicyService,
    PushService,
  ],
  exports: [ChannelMessenger, AppMessageService, AppMessageNotifier],
})
export class MessagingModule {}
