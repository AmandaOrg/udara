import { Logger } from "@nestjs/common";
import { ChannelMessenger } from "./channel-messenger";
import { runInChannel } from "./channel-context";

/**
 * Routing only: which adapter says it, whether the app gets a silent copy,
 * whether a push goes out. What each channel does with a message is its
 * adapter's business, and where a message with no context goes is
 * delivery-policy.spec.ts.
 */
describe("ChannelMessenger", () => {
  const user = { id: "user-1", whatsappNumber: "234801" };
  let whatsapp: Record<string, jest.Mock>;
  let app: Record<string, jest.Mock>;
  let policy: { plan: jest.Mock };
  let push: { notify: jest.Mock };
  let messenger: ChannelMessenger;
  let warn: jest.SpyInstance;

  const adapterMock = () => ({
    sendText: jest.fn().mockResolvedValue(undefined),
    sendButtons: jest.fn().mockResolvedValue(undefined),
    sendList: jest.fn().mockResolvedValue(undefined),
    sendChunked: jest.fn().mockResolvedValue(undefined),
    requestForm: jest.fn().mockResolvedValue(true),
    sendTemplate: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    whatsapp = adapterMock();
    app = adapterMock();
    policy = {
      plan: jest.fn().mockResolvedValue({
        channel: "whatsapp",
        mirrorToApp: false,
        push: false,
      }),
    };
    push = { notify: jest.fn().mockResolvedValue(undefined) };
    messenger = new ChannelMessenger(
      whatsapp as any,
      app as any,
      policy as any,
      push as any,
    );
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  describe("inside a user's turn", () => {
    it("replies on the channel the event arrived on, without asking the policy", async () => {
      await runInChannel({ channel: "whatsapp" }, () =>
        messenger.sendText(user, "hi"),
      );
      await runInChannel({ channel: "app", deviceId: "d1" }, () =>
        messenger.sendText(user, "hello"),
      );

      expect(whatsapp.sendText).toHaveBeenCalledWith(user, "hi");
      expect(app.sendText).toHaveBeenCalledWith(user, "hello");
      expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
      expect(policy.plan).not.toHaveBeenCalled();
      expect(push.notify).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps the context across awaits inside the handler", async () => {
      await runInChannel({ channel: "app", deviceId: "d1" }, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await messenger.sendText(user, "later");
      });

      expect(app.sendText).toHaveBeenCalledWith(user, "later");
    });
  });

  describe("a pinned channel", () => {
    /**
     * A sign-in approval can only be answered on WhatsApp, and a new-device
     * warning must not land on the new device. Neither may follow the user.
     */
    it("beats both the context and the policy", async () => {
      await runInChannel({ channel: "app", deviceId: "d1" }, () =>
        messenger.sendText(user, "was this you?", {
          delivery: "transactional",
          channel: "whatsapp",
        }),
      );

      expect(whatsapp.sendText).toHaveBeenCalledWith(user, "was this you?");
      expect(app.sendText).not.toHaveBeenCalled();
      expect(policy.plan).not.toHaveBeenCalled();
      expect(push.notify).not.toHaveBeenCalled();
    });
  });

  describe("outside any turn", () => {
    it("asks the policy, passing the payment's origin", async () => {
      await messenger.sendText(user, "done", {
        delivery: "transactional",
        origin: "app",
      });

      expect(policy.plan).toHaveBeenCalledWith(user, {
        delivery: "transactional",
        origin: "app",
      });
    });

    it("copies a WhatsApp message into the app chat without a push", async () => {
      policy.plan.mockResolvedValue({
        channel: "whatsapp",
        mirrorToApp: true,
        push: false,
      });

      await messenger.sendText(user, "money in", {
        delivery: "transactional",
      });

      expect(whatsapp.sendText).toHaveBeenCalledWith(user, "money in");
      expect(app.sendText).toHaveBeenCalledWith(user, "money in");
      expect(push.notify).not.toHaveBeenCalled();
    });

    it("pushes when the message lands only in the app", async () => {
      policy.plan.mockResolvedValue({
        channel: "app",
        mirrorToApp: false,
        push: true,
      });

      await messenger.sendChunked(user, "your week\n\nin numbers", {
        delivery: "proactive",
      });

      expect(app.sendChunked).toHaveBeenCalled();
      expect(whatsapp.sendChunked).not.toHaveBeenCalled();
      expect(push.notify).toHaveBeenCalledWith("user-1", "proactive");
    });

    it("never lets a failed copy to the app fail the message itself", async () => {
      policy.plan.mockResolvedValue({
        channel: "whatsapp",
        mirrorToApp: true,
        push: false,
      });
      app.sendText.mockRejectedValue(new Error("db down"));

      await expect(
        messenger.sendText(user, "done", { delivery: "transactional" }),
      ).resolves.toBeUndefined();
      expect(whatsapp.sendText).toHaveBeenCalled();
    });

    /**
     * A reply with no inbound event behind it means an entry point forgot to
     * open a context. It still goes out, but it is reported.
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

      expect(warn).not.toHaveBeenCalled();
    });

    it("says where a send would go without sending it", async () => {
      policy.plan.mockResolvedValue({
        channel: "app",
        mirrorToApp: false,
        push: true,
      });

      await expect(
        messenger.resolveDelivery(user, { delivery: "proactive" }),
      ).resolves.toBe("app");
      expect(app.sendText).not.toHaveBeenCalled();
      expect(push.notify).not.toHaveBeenCalled();
    });

    // ADR-0003: the policy has no plan for a closed account.
    it("sends nothing at all to a closed account, on any channel", async () => {
      policy.plan.mockResolvedValue(null);
      const form = {
        kind: "PIN_ENTRY" as const,
        token: "tok",
        headerText: "h",
        bodyText: "b",
        ctaText: "c",
      };

      await messenger.sendText(user, "hi", { delivery: "proactive" });
      await messenger.sendChunked(user, "a\n\nb", {
        delivery: "transactional",
      });
      await expect(
        messenger.requestForm(user, form, { delivery: "transactional" }),
      ).resolves.toBe(false);

      for (const adapter of [whatsapp, app]) {
        for (const method of Object.values(adapter)) {
          expect(method).not.toHaveBeenCalled();
        }
      }
      expect(push.notify).not.toHaveBeenCalled();
    });
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
