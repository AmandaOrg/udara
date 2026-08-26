import {
  ChunkedMessengerService,
  splitIntoChunks,
} from "./chunked-messenger.service";

describe("splitIntoChunks", () => {
  it("splits on blank-line boundaries and trims each chunk", () => {
    expect(
      splitIntoChunks("hey\n\nsaw you tried to send 8k\n\nwho's this for?"),
    ).toEqual(["hey", "saw you tried to send 8k", "who's this for?"]);
  });

  it("keeps a single-block structured list intact (no internal blank lines)", () => {
    const list = "your plan:\n- daily: 10k\n- weekly: 70k\n- monthly: 300k";
    expect(splitIntoChunks(list)).toEqual([list]);
  });

  it("drops empty chunks from extra blank lines", () => {
    expect(splitIntoChunks("hey\n\n\n\nyo")).toEqual(["hey", "yo"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitIntoChunks("   \n\n  ")).toEqual([]);
  });
});

describe("ChunkedMessengerService", () => {
  let whatsapp: { sendText: jest.Mock; markAsReadWithTyping: jest.Mock };
  let prisma: { whatsappMessage: { findFirst: jest.Mock } };
  let service: ChunkedMessengerService;
  let sleepSpy: jest.SpyInstance;

  beforeEach(() => {
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      markAsReadWithTyping: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      whatsappMessage: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ waMessageId: "wamid.inbound" }),
      },
    };
    service = new ChunkedMessengerService(whatsapp as any, prisma as any);
    // Skip real timers — verify the *calls* to sleep (delay math), not wall-clock time.
    sleepSpy = jest.spyOn(service as any, "sleep").mockResolvedValue(undefined);
  });

  it("sends each chunk as a separate WhatsappService.sendText call, in order", async () => {
    await service.sendChunkedReply(
      "234801",
      "hey\n\nwhat's up\n\nyou there?",
      "user-1",
    );

    expect(whatsapp.sendText.mock.calls.map((c) => c[1])).toEqual([
      "hey",
      "what's up",
      "you there?",
    ]);
    expect(whatsapp.sendText).toHaveBeenNthCalledWith(
      1,
      "234801",
      "hey",
      "user-1",
    );
  });

  it("sends nothing for blank input", async () => {
    await service.sendChunkedReply("234801", "   ", "user-1");
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("sends the first chunk with no delay", async () => {
    await service.sendChunkedReply("234801", "hey", "user-1");
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("inserts a short gap delay between chunks but not before the first one", async () => {
    await service.sendChunkedReply("234801", "one\n\ntwo\n\nthree", "user-1");
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    for (const [gap] of sleepSpy.mock.calls) {
      expect(gap).toBeGreaterThanOrEqual(400);
      expect(gap).toBeLessThanOrEqual(700);
    }
  });

  it("keeps the inter-chunk gap short regardless of chunk length", async () => {
    const longChunk = new Array(50).fill("word").join(" ");
    await service.sendChunkedReply(
      "234801",
      `${longChunk}\n\nsecond chunk`,
      "user-1",
    );
    const [gap] = sleepSpy.mock.calls[0];
    expect(gap).toBeGreaterThanOrEqual(400);
    expect(gap).toBeLessThanOrEqual(700);
  });

  it("re-shows the typing indicator (against the user's last inbound message) before each gap", async () => {
    await service.sendChunkedReply("234801", "one\n\ntwo\n\nthree", "user-1");

    expect(prisma.whatsappMessage.findFirst).toHaveBeenCalledTimes(2);
    expect(whatsapp.markAsReadWithTyping).toHaveBeenCalledTimes(2);
    expect(whatsapp.markAsReadWithTyping).toHaveBeenCalledWith("wamid.inbound");
  });

  it("doesn't fail the send if there's no inbound message to key the typing indicator off, or the call errors", async () => {
    prisma.whatsappMessage.findFirst.mockResolvedValueOnce(null);
    whatsapp.markAsReadWithTyping.mockRejectedValueOnce(new Error("boom"));

    await service.sendChunkedReply("234801", "one\n\ntwo\n\nthree", "user-1");

    expect(whatsapp.sendText).toHaveBeenCalledTimes(3);
  });
});
