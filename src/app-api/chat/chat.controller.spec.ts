import { BadRequestException } from "@nestjs/common";
import { ChatController } from "./chat.controller";

describe("ChatController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  let chat: Record<string, jest.Mock>;
  let controller: ChatController;

  beforeEach(() => {
    chat = {
      sendText: jest.fn().mockResolvedValue({ id: "m1" }),
      sendChoice: jest.fn().mockResolvedValue({ id: "m2" }),
      list: jest.fn().mockResolvedValue({ messages: [] }),
      start: jest.fn().mockResolvedValue({ id: "m3" }),
    };
    controller = new ChatController(chat as any);
  });

  it("sends text", async () => {
    await controller.send(principal, {
      clientMessageId: "c-00000001",
      text: "balance",
    });

    expect(chat.sendText).toHaveBeenCalledWith(
      principal,
      "c-00000001",
      "balance",
    );
  });

  it("sends a choice", async () => {
    const reply = { messageId: "m-offer", choiceId: "intro:yes" };

    await controller.send(principal, { clientMessageId: "c-00000001", reply });

    expect(chat.sendChoice).toHaveBeenCalledWith(
      principal,
      "c-00000001",
      reply,
    );
  });

  it.each([
    ["neither", {}],
    [
      "both",
      { text: "yes", reply: { messageId: "m-offer", choiceId: "intro:yes" } },
    ],
  ])("refuses %s text and a choice", (_label, body) => {
    expect(() =>
      controller.send(principal, { clientMessageId: "c-00000001", ...body }),
    ).toThrow(BadRequestException);
    expect(chat.sendText).not.toHaveBeenCalled();
    expect(chat.sendChoice).not.toHaveBeenCalled();
  });

  it("reads from the cursor the app holds, which may be past 2^53", async () => {
    await controller.list(principal, {
      after: "9007199254740993",
      waitMs: 20_000,
    });

    expect(chat.list).toHaveBeenCalledWith(
      principal,
      9007199254740993n,
      20_000,
    );
  });

  it("reads the latest page without waiting by default", async () => {
    await controller.list(principal, {});

    expect(chat.list).toHaveBeenCalledWith(principal, undefined, 0);
  });
});
