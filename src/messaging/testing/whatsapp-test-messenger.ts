import { ChannelMessenger } from "../channel-messenger";
import { WhatsappChannelAdapter } from "../whatsapp-channel.adapter";

class QuietChannelMessenger extends ChannelMessenger {
  // Unit tests call services directly, outside any inbound event, so every
  // reply would otherwise be reported as missing its context.
  protected override reportMissingContext(): void {}
}

/**
 * A real ChannelMessenger over WhatsApp mocks, for specs of classes that send.
 *
 * Deliberately the real adapter rather than a mocked port: specs keep
 * asserting on the exact WhatsappService / ChunkedMessengerService calls, so
 * they prove the port reproduces WhatsApp output rather than restating it.
 */
export function whatsappTestMessenger(mocks: {
  whatsapp?: object;
  chunkedMessenger?: object;
  config?: object;
}): ChannelMessenger {
  const adapter = new WhatsappChannelAdapter(
    (mocks.whatsapp ?? {}) as never,
    (mocks.chunkedMessenger ?? {}) as never,
    (mocks.config ?? { get: () => undefined }) as never,
  );
  return new QuietChannelMessenger(adapter);
}
