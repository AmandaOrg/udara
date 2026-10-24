import { HttpException, Logger, NotFoundException } from "@nestjs/common";
import { AppConversationService } from "./app-conversation.service";
import { currentChannelContext } from "../../messaging/channel-context";

describe("AppConversationService", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  const user = { id: "user-1", whatsappNumber: null };
  let store: Record<string, jest.Mock>;
  let notifier: { wait: jest.Mock };
  let conversation: Record<string, jest.Mock>;
  let onboarding: { startConversation: jest.Mock };
  let turns: { run: jest.Mock };
  let rateLimit: { check: jest.Mock };
  let messenger: { sendText: jest.Mock };
  let service: AppConversationService;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "in-1",
    seq: 12n,
    userId: "user-1",
    direction: "INBOUND",
    kind: "TEXT",
    body: "hello",
    status: "RECEIVED",
    ...overrides,
  });

  beforeEach(() => {
    store = {
      recordInbound: jest.fn(async (_userId, input) => ({
        row: row({ kind: input.kind, body: input.body ?? null }),
        isNew: true,
      })),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      findOfferedChoice: jest.fn().mockResolvedValue("Yes, I understand"),
      list: jest.fn().mockResolvedValue([]),
      isProcessing: jest.fn().mockResolvedValue(false),
    };
    notifier = { wait: jest.fn().mockResolvedValue(false) };
    conversation = {
      handleText: jest.fn().mockResolvedValue(undefined),
      handleChoice: jest.fn().mockResolvedValue(undefined),
      handlePinForm: jest.fn().mockResolvedValue(undefined),
      handleKycForm: jest.fn().mockResolvedValue(undefined),
    };
    onboarding = { startConversation: jest.fn().mockResolvedValue(undefined) };
    turns = { run: jest.fn((_userId, _channel, fn) => fn(user)) };
    rateLimit = {
      check: jest
        .fn()
        .mockResolvedValue({ limited: false, justCrossed: false }),
    };
    messenger = { sendText: jest.fn().mockResolvedValue(undefined) };
    service = new AppConversationService(
      store as any,
      notifier as any,
      conversation as any,
      onboarding as any,
      turns as any,
      rateLimit as any,
      messenger as any,
    );
  });

  describe("accepting a message", () => {
    it("answers at once, then handles it as an app turn for that user and device", async () => {
      let context: unknown;
      conversation.handleText.mockImplementation(async () => {
        context = currentChannelContext();
      });

      const accepted = await service.sendText(principal, "c-00000001", "hello");
      expect(accepted).toEqual({ id: "in-1", seq: "12", status: "received" });

      await service.drain();
      expect(turns.run).toHaveBeenCalledWith(
        "user-1",
        "app",
        expect.any(Function),
      );
      expect(context).toEqual({ channel: "app", deviceId: "device-1" });
      expect(conversation.handleText).toHaveBeenCalledWith(user, "hello");
      expect(store.markProcessed).toHaveBeenCalledWith("in-1", "PROCESSED");
    });

    it("hands the conversation the stored, scrubbed text, never the raw request", async () => {
      store.recordInbound.mockResolvedValue({
        row: row({ body: "my pin is [redacted]" }),
        isNew: true,
      });

      await service.sendText(principal, "c-00000001", "my pin is 4821");
      await service.drain();

      expect(conversation.handleText).toHaveBeenCalledWith(
        user,
        "my pin is [redacted]",
      );
    });

    it("does not handle a retried send a second time", async () => {
      store.recordInbound.mockResolvedValue({
        row: row({ status: "PROCESSED" }),
        isNew: false,
      });

      const accepted = await service.sendText(principal, "c-00000001", "hi");
      await service.drain();

      expect(accepted.status).toBe("processed");
      expect(rateLimit.check).not.toHaveBeenCalled();
      expect(turns.run).not.toHaveBeenCalled();
    });

    it("refuses with 429 over the shared rate limit, and handles nothing", async () => {
      rateLimit.check.mockResolvedValue({ limited: true, justCrossed: true });

      const attempt = service.sendText(principal, "c-00000001", "spam");

      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({ status: 429 });
      expect(store.markProcessed).toHaveBeenCalledWith("in-1", "FAILED");
      expect(turns.run).not.toHaveBeenCalled();
    });

    it("says something went wrong when a turn fails, rather than going quiet", async () => {
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation();
      conversation.handleText.mockRejectedValue(new Error("llm down"));

      await service.sendText(principal, "c-00000001", "hello");
      await service.drain();

      expect(store.markProcessed).toHaveBeenCalledWith("in-1", "FAILED");
      expect(messenger.sendText).toHaveBeenCalledWith(
        user,
        expect.stringContaining("something went wrong"),
      );
      error.mockRestore();
    });
  });

  describe("choices", () => {
    it("routes a choice the user was actually offered", async () => {
      await service.sendChoice(principal, "c-00000002", {
        messageId: "11111111-1111-1111-1111-111111111111",
        choiceId: "intro:yes",
      });
      await service.drain();

      expect(store.findOfferedChoice).toHaveBeenCalledWith(
        "user-1",
        "11111111-1111-1111-1111-111111111111",
        "intro:yes",
      );
      expect(store.recordInbound).toHaveBeenCalledWith("user-1", {
        clientMessageId: "c-00000002",
        kind: "CHOICE",
        body: "Yes, I understand",
        payload: {
          replyTo: "11111111-1111-1111-1111-111111111111",
          choiceId: "intro:yes",
        },
      });
      expect(conversation.handleChoice).toHaveBeenCalledWith(user, "intro:yes");
    });

    /**
     * The app can name any message and any id. Without this, one user could
     * tap "confirm" on another user's transfer by sending its id.
     */
    it("is a 404, recording nothing, for anything not offered to this user", async () => {
      store.findOfferedChoice.mockResolvedValue(null);

      await expect(
        service.sendChoice(principal, "c-00000002", {
          messageId: "22222222-2222-2222-2222-222222222222",
          choiceId: "confirm:someone-elses-transfer",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(store.recordInbound).not.toHaveBeenCalled();
      expect(conversation.handleChoice).not.toHaveBeenCalled();
    });
  });

  describe("forms", () => {
    const kyc = {
      clientMessageId: "c-00000003",
      token: "kyc-tok",
      firstName: "Daniel",
      lastName: "Okafor",
      idType: "BVN" as const,
      idNumber: "22123456789",
      email: "me@example.com",
      dateOfBirth: "1998-04-12",
    };

    it("stores only which form arrived, and hands the ID number over in memory", async () => {
      await service.submitKyc(principal, kyc);
      await service.drain();

      const stored = store.recordInbound.mock.calls[0][1];
      expect(stored).toEqual({
        clientMessageId: "c-00000003",
        kind: "FORM_SUBMISSION",
        payload: { form: "KYC" },
      });
      expect(JSON.stringify(stored)).not.toContain("22123456789");
      expect(JSON.stringify(stored)).not.toContain("1998-04-12");

      const [, form, sensitive] = conversation.handleKycForm.mock.calls[0];
      expect(form).toEqual({
        flow_token: "kyc-tok",
        first_name: "Daniel",
        middle_name: "",
        last_name: "Okafor",
        id_type: "BVN",
        email: "me@example.com",
      });
      expect(sensitive).toEqual({
        id_number: "22123456789",
        date_of_birth: "1998-04-12",
      });
    });

    it("hands a PIN over only in memory, with only the fields that were sent", async () => {
      await service.submitPin(principal, {
        clientMessageId: "c-00000004",
        token: "pin-tok",
        pin: "4821",
        pinConfirm: "4821",
      });
      await service.drain();

      const stored = store.recordInbound.mock.calls[0][1];
      expect(JSON.stringify(stored)).not.toContain("4821");
      expect(conversation.handlePinForm).toHaveBeenCalledWith(
        user,
        { flow_token: "pin-tok" },
        { pin: "4821", pin_confirm: "4821" },
      );
    });
  });

  it("starts the conversation through onboarding", async () => {
    await service.start(principal, "c-00000005");
    await service.drain();

    expect(onboarding.startConversation).toHaveBeenCalledWith(user);
  });

  describe("reading", () => {
    const outbound = {
      id: "out-1",
      seq: 13n,
      userId: "user-1",
      direction: "OUTBOUND",
      kind: "BUTTONS",
      body: "do you understand?",
      payload: { buttons: [{ id: "intro:yes", title: "Yes, I understand" }] },
      createdAt: new Date("2026-09-26T10:00:00Z"),
    };

    it("returns what is there straight away, with the cursor moved past it", async () => {
      store.list.mockResolvedValue([outbound]);

      const page = await service.list(principal, 12n, 20_000);

      expect(store.list).toHaveBeenCalledWith("user-1", 12n);
      expect(page.cursor).toBe("13");
      expect(page.messages[0]).toMatchObject({
        id: "out-1",
        seq: "13",
        direction: "outbound",
        kind: "buttons",
        text: "do you understand?",
        buttons: [{ id: "intro:yes", title: "Yes, I understand" }],
      });
      expect(notifier.wait).not.toHaveBeenCalled();
    });

    it("waits for something new, then returns it", async () => {
      store.list.mockResolvedValueOnce([]).mockResolvedValueOnce([outbound]);
      notifier.wait.mockResolvedValue(true);

      const page = await service.list(principal, 12n, 20_000);

      expect(notifier.wait).toHaveBeenCalledTimes(1);
      expect(page.messages).toHaveLength(1);
    });

    it("returns when a turn finishes with nothing to say, so the app stops showing it as busy", async () => {
      store.isProcessing
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const page = await service.list(principal, 12n, 20_000);

      expect(page).toEqual({ messages: [], cursor: "12", processing: false });
    });

    it("does not wait at all without waitMs", async () => {
      const page = await service.list(principal, undefined, 0);

      expect(notifier.wait).not.toHaveBeenCalled();
      expect(page.cursor).toBeNull();
    });
  });
});
