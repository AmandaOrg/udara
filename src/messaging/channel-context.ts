import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "@prisma/client";

/** A surface a user can talk to Udara through. */
export type Channel = "whatsapp" | "app";

export interface ChannelContext {
  channel: Channel;
  /**
   * The signed-in app device the event came from. Set only on the app channel;
   * the new-device transfer cap keys on it.
   */
  deviceId?: string;
}

/**
 * Which channel the event being handled right now arrived on.
 *
 * Carried implicitly rather than passed as an argument because the call chains
 * that end in a send are deep (router -> account actions -> transfer
 * confirmation -> PIN gate) and every link would otherwise have to thread a
 * parameter it never reads. Each inbound entry point opens a context around
 * exactly one event; code that runs outside any context (crons, provider
 * webhooks, CLIs) is not replying to anyone, and ChannelMessenger routes it by
 * delivery policy instead.
 */
const storage = new AsyncLocalStorage<ChannelContext>();

export function runInChannel<T>(
  context: ChannelContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function currentChannelContext(): ChannelContext | undefined {
  return storage.getStore();
}

/**
 * Picks the copy for the channel being answered. Outside any context it is the
 * WhatsApp text, which is what every message said before the app existed.
 */
export function forChannel<T>(copy: Record<Channel, T>): T {
  return copy[currentChannelContext()?.channel ?? "whatsapp"];
}

export function toMessageChannel(channel: Channel): MessageChannel {
  return channel === "app" ? MessageChannel.APP : MessageChannel.WHATSAPP;
}

export function fromMessageChannel(channel: MessageChannel): Channel {
  return channel === MessageChannel.APP ? "app" : "whatsapp";
}

/**
 * The channel of the event being handled, as stored on a row. Outside any
 * context that is WhatsApp, where everything happened before the app.
 */
export function currentMessageChannel(): MessageChannel {
  return toMessageChannel(currentChannelContext()?.channel ?? "whatsapp");
}
