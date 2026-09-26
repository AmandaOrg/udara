import { ChannelMessenger } from "../channel-messenger";
import { WhatsappChannelAdapter } from "../whatsapp-channel.adapter";
import { AppChannelAdapter } from "../app-channel.adapter";

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
  /** AppMessageService mock, for specs that also exercise the app channel. */
  appMessages?: object;
}): ChannelMessenger {
  const adapter = new WhatsappChannelAdapter(
    (mocks.whatsapp ?? {}) as never,
    (mocks.chunkedMessenger ?? {}) as never,
    (mocks.config ?? { get: () => undefined }) as never,
  );
  const app = new AppChannelAdapter(
    (mocks.appMessages ?? {
      recordOutbound: () => Promise.resolve(undefined),
    }) as never,
  );
  // Outside a context, the routing every spec was written against: WhatsApp
  // for anyone who has it, no copy to the app, no push. delivery-policy.spec.ts
  // covers the real rules.
  const policy = {
    plan: (to: { whatsappNumber?: string | null }) =>
      Promise.resolve({
        channel: to.whatsappNumber ? "whatsapp" : "app",
        mirrorToApp: false,
        push: false,
      }),
  };
  const push = { notify: () => Promise.resolve() };
  return new QuietChannelMessenger(
    adapter,
    app,
    policy as never,
    push as never,
  );
}
