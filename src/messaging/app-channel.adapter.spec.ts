import { Logger } from "@nestjs/common";
import { AppChannelAdapter } from "./app-channel.adapter";

describe("AppChannelAdapter", () => {
  const user = { id: "user-1", whatsappNumber: null };
  let store: { recordOutbound: jest.Mock };
  let adapter: AppChannelAdapter;

  beforeEach(() => {
    store = { recordOutbound: jest.fn().mockResolvedValue({}) };
    adapter = new AppChannelAdapter(store as any);
  });

  it("writes text, buttons and lists as one row each", async () => {
    const buttons = [{ id: "intro:yes", title: "Yes, I understand" }];
    const rows = [
      { id: "sq1:a", title: "Rarely", description: "once a month" },
    ];

    await adapter.sendText(user, "hello");
    await adapter.sendButtons(user, "do you understand?", buttons);
    await adapter.sendList(user, "how often?", "Pick one", rows);

    expect(store.recordOutbound.mock.calls).toEqual([
      ["user-1", { kind: "TEXT", body: "hello" }],
      ["user-1", { kind: "BUTTONS", body: "do you understand?", buttons }],
      [
        "user-1",
        { kind: "LIST", body: "how often?", buttonLabel: "Pick one", rows },
      ],
    ]);
  });

  it("splits model text into one bubble per paragraph, like WhatsApp", async () => {
    await adapter.sendChunked(user, "first thought.\n\nsecond one.\n\n\n");

    expect(store.recordOutbound.mock.calls).toEqual([
      ["user-1", { kind: "TEXT", body: "first thought." }],
      ["user-1", { kind: "TEXT", body: "second one." }],
    ]);
  });

  it("asks for a form with the token the submission must carry back, and can always show it", async () => {
    const form = {
      kind: "PIN_SETUP" as const,
      token: "tok-1",
      headerText: "Set your transfer PIN",
      bodyText: "Choose a 4-digit PIN.",
      ctaText: "Set PIN",
    };

    await expect(adapter.requestForm(user, form)).resolves.toBe(true);
    expect(store.recordOutbound).toHaveBeenCalledWith("user-1", {
      kind: "FORM_REQUEST",
      form,
    });
  });

  it("writes nothing for a WhatsApp template, which has no meaning in the app", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();

    await adapter.sendTemplate(user, "window_open_nudge");

    expect(store.recordOutbound).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
