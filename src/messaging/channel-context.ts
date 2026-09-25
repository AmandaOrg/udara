import { AsyncLocalStorage } from "node:async_hooks";

/** A surface a user can talk to Udara through. */
export type Channel = "whatsapp" | "app";

export interface ChannelContext {
  channel: Channel;
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
