import { Logger } from "@nestjs/common";
import { ChannelMessenger } from "./channel-messenger";
import { runInChannel } from "./channel-context";

/**
 * Routing only. What each channel does with a message is the adapter's
 * business (whatsapp-channel.adapter.spec.ts).
 */
describe("ChannelMessenger", () => {
  const user = { id: "user-1", whatsappNumber: "234801" };
  let whatsapp: Record<string, jest.Mock>;
  let messenger: ChannelMessenger;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    whatsapp = {
      sendText: jest.fn().mockResolvedValue(undefined),
      sendButtons: jest.fn().mockResolvedValue(undefined),
      sendList: jest.fn().mockResolvedValue(undefined),
      sendChunked: jest.fn().mockResolvedValue(undefined),
      requestForm: jest.fn().mockResolvedValue(true),
      sendTemplate: jest.fn().mockResolvedValue(undefined),
    };
    messenger = new ChannelMessenger(whatsapp as any);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  it("replies on the channel the inbound event arrived on", async () => {
    await runInChannel({ channel: "whatsapp" }, () =>
      messenger.sendText(user, "hi"),
    );

    expect(whatsapp.sendText).toHaveBeenCalledWith(user, "hi");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the context across awaits inside the handler", async () => {
    await runInChannel({ channel: "whatsapp" }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await messenger.sendText(user, "later");
    });

    expect(whatsapp.sendText).toHaveBeenCalledWith(user, "later");
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * A reply with no inbound event behind it means an entry point forgot to open
   * a context. It still goes out, but it is reported, because for an app user
   * it would go to the wrong channel.
   */
  it("reports a reply sent outside any channel context, and still delivers it", async () => {
    await messenger.sendText(user, "orphan");

    expect(whatsapp.sendText).toHaveBeenCalledWith(user, "orphan");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("outside any channel context"),
    );
  });

  it("does not report proactive or transactional sends, which have no inbound event by nature", async () => {
    await messenger.sendText(user, "nudge", { delivery: "proactive" });
    await messenger.sendText(user, "done", { delivery: "transactional" });

    expect(whatsapp.sendText).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a channel it has no adapter for rather than guessing", async () => {
    await expect(
      runInChannel({ channel: "app" }, () => messenger.sendText(user, "hi")),
    ).rejects.toThrow('no adapter for channel "app"');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("passes every kind of message through unchanged", async () => {
    const buttons = [{ id: "b1", title: "Yes" }];
    const rows = [{ id: "r1", title: "Row" }];
    const form = {
      kind: "PIN_ENTRY" as const,
      token: "tok",
      headerText: "h",
      bodyText: "b",
      ctaText: "c",
    };

    await runInChannel({ channel: "whatsapp" }, async () => {
      await messenger.sendButtons(user, "pick", buttons);
      await messenger.sendList(user, "choose", "Open", rows);
      await messenger.sendChunked(user, "one\n\ntwo");
      expect(await messenger.requestForm(user, form)).toBe(true);
      await messenger.sendTemplate(user, "tpl", "en_US", undefined);
    });

    expect(whatsapp.sendButtons).toHaveBeenCalledWith(user, "pick", buttons);
    expect(whatsapp.sendList).toHaveBeenCalledWith(
      user,
      "choose",
      "Open",
      rows,
    );
    expect(whatsapp.sendChunked).toHaveBeenCalledWith(user, "one\n\ntwo");
    expect(whatsapp.requestForm).toHaveBeenCalledWith(user, form);
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith(
      user,
      "tpl",
      "en_US",
      undefined,
    );
  });
});
