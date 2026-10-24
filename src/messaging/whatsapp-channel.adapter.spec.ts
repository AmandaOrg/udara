import { Logger } from "@nestjs/common";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";

/**
 * The adapter must reproduce exactly the WhatsappService calls the domain
 * services used to make themselves: same number, same body, same userId on
 * the outbound row.
 */
describe("WhatsappChannelAdapter", () => {
  const user = { id: "user-1", whatsappNumber: "234801" };
  let whatsapp: Record<string, jest.Mock>;
  let chunkedMessenger: { sendChunkedReply: jest.Mock };
  let flowIds: Record<string, string | undefined>;
  let adapter: WhatsappChannelAdapter;

  beforeEach(() => {
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "w" }),
      sendInteractiveButtons: jest.fn().mockResolvedValue({ waMessageId: "w" }),
      sendListMessage: jest.fn().mockResolvedValue({ waMessageId: "w" }),
      sendTemplate: jest.fn().mockResolvedValue({ waMessageId: "w" }),
      sendFlow: jest.fn().mockResolvedValue({ waMessageId: "w" }),
    };
    chunkedMessenger = {
      sendChunkedReply: jest.fn().mockResolvedValue(undefined),
    };
    flowIds = {
      WHATSAPP_KYC_FLOW_ID: "flow-kyc",
      WHATSAPP_PIN_ENTRY_FLOW_ID: "flow-entry",
      WHATSAPP_PIN_SETUP_FLOW_ID: "flow-setup",
      WHATSAPP_PIN_RESET_FLOW_ID: "flow-reset",
    };
    adapter = new WhatsappChannelAdapter(
      whatsapp as any,
      chunkedMessenger as any,
      { get: (key: string) => flowIds[key] } as any,
    );
  });

  it("addresses every send to the user's number and records it against the user", async () => {
    const buttons = [{ id: "b1", title: "Yes" }];
    const rows = [{ id: "r1", title: "Row", description: "d" }];

    await adapter.sendText(user, "hi");
    await adapter.sendButtons(user, "pick", buttons);
    await adapter.sendList(user, "choose", "Open", rows);
    await adapter.sendChunked(user, "one\n\ntwo");
    await adapter.sendTemplate(user, "window_open", "en_US", undefined);

    expect(whatsapp.sendText).toHaveBeenCalledWith("234801", "hi", "user-1");
    expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(
      "234801",
      "pick",
      buttons,
      "user-1",
    );
    expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
      "234801",
      "choose",
      "Open",
      rows,
      "user-1",
    );
    expect(chunkedMessenger.sendChunkedReply).toHaveBeenCalledWith(
      "234801",
      "one\n\ntwo",
      "user-1",
    );
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith(
      "234801",
      "window_open",
      "en_US",
      undefined,
      "user-1",
    );
  });

  it.each([
    ["KYC", "flow-kyc", "KYC"],
    ["PIN_ENTRY", "flow-entry", "PIN_ENTRY"],
    ["PIN_SETUP", "flow-setup", "PIN_SETUP"],
    ["PIN_RESET", "flow-reset", "PIN_RESET"],
  ] as const)(
    "renders a %s form as its published Flow, carrying the caller's token",
    async (kind, flowId, screenId) => {
      const shown = await adapter.requestForm(user, {
        kind,
        token: "tok-1",
        headerText: "Header",
        bodyText: "Body",
        ctaText: "Go",
      });

      expect(shown).toBe(true);
      expect(whatsapp.sendFlow).toHaveBeenCalledWith({
        to: "234801",
        flowId,
        flowToken: "tok-1",
        screenId,
        headerText: "Header",
        bodyText: "Body",
        ctaText: "Go",
        userId: "user-1",
      });
    },
  );

  it("reports a form whose Flow isn't published in this environment, without sending", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    flowIds.WHATSAPP_PIN_ENTRY_FLOW_ID = undefined;

    const shown = await adapter.requestForm(user, {
      kind: "PIN_ENTRY",
      token: "tok-1",
      headerText: "h",
      bodyText: "b",
      ctaText: "c",
    });

    expect(shown).toBe(false);
    expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WHATSAPP_PIN_ENTRY_FLOW_ID is not set"),
    );
    warn.mockRestore();
  });

  it("sends nothing on WhatsApp for a user who has only used the app", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const appOnly = { id: "user-2", whatsappNumber: null };

    await adapter.sendText(appOnly, "hi");
    await adapter.sendChunked(appOnly, "hi");
    const shown = await adapter.requestForm(appOnly, {
      kind: "PIN_ENTRY",
      token: "tok-1",
      headerText: "h",
      bodyText: "b",
      ctaText: "c",
    });

    expect(shown).toBe(false);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(chunkedMessenger.sendChunkedReply).not.toHaveBeenCalled();
    expect(whatsapp.sendFlow).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("user-2 has no WhatsApp number"),
    );
    warn.mockRestore();
  });
});
