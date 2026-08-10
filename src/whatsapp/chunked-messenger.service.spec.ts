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
  let whatsapp: { sendText: jest.Mock };
  let service: ChunkedMessengerService;
  let sleepSpy: jest.SpyInstance;

  beforeEach(() => {
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
    };
    service = new ChunkedMessengerService(whatsapp as any);
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

  it("applies an initial read delay before the first send", async () => {
    await service.sendChunkedReply("234801", "hey", "user-1");
    // read delay + 1 typing delay = 2 sleep calls for a single-chunk reply
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    const [readDelay] = sleepSpy.mock.calls[0];
    expect(readDelay).toBeGreaterThanOrEqual(1000);
    expect(readDelay).toBeLessThanOrEqual(3000);
  });

  it("uses a longer initial read delay for a long first chunk", async () => {
    const longFirstChunk = new Array(31).fill("word").join(" ");
    await service.sendChunkedReply("234801", longFirstChunk, "user-1");
    const [readDelay] = sleepSpy.mock.calls[0];
    expect(readDelay).toBeGreaterThanOrEqual(3000);
    expect(readDelay).toBeLessThanOrEqual(6000);
  });

  it("inserts a gap delay between chunks but not before the first one", async () => {
    await service.sendChunkedReply("234801", "one\n\ntwo\n\nthree", "user-1");
    // read delay, [typing(1)], gap, typing(2), gap, typing(3) = 1 + 1 + 1 + 1 + 1 + 1 = 6 calls
    expect(sleepSpy).toHaveBeenCalledTimes(6);
  });

  it("computes typing delay roughly proportional to word count", async () => {
    await service.sendChunkedReply(
      "234801",
      "one two three four five six seven eight nine ten",
      "user-1",
    );
    const typingDelay = sleepSpy.mock.calls[1][0]; // [0] is the read delay
    // 10 words at 40-60wpm -> between 10s and 15s
    expect(typingDelay).toBeGreaterThanOrEqual(10_000);
    expect(typingDelay).toBeLessThanOrEqual(15_000);
  });
});
