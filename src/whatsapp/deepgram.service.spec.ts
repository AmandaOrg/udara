import { DeepgramService } from "./deepgram.service";

describe("DeepgramService", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function service(env: Record<string, string | undefined>) {
    return new DeepgramService({
      get: (key: string, fallback?: string) => env[key] ?? fallback ?? "",
    } as any);
  }

  it("isConfigured is false without a key", () => {
    expect(service({}).isConfigured()).toBe(false);
  });

  it("returns not_configured without calling the network", async () => {
    global.fetch = jest.fn();
    const result = await service({}).transcribe(Buffer.from("ogg"));
    expect(result).toEqual({
      ok: false,
      text: "",
      language: null,
      error: "not_configured",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("posts audio with Token auth and returns the transcript", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: {
          channels: [
            {
              detected_language: "en",
              alternatives: [{ transcript: "  send 800 to opay  " }],
            },
          ],
        },
      }),
    });

    const result = await service({
      DEEPGRAM_API_KEY: "dg-test",
      DEEPGRAM_STT_MODEL: "nova-3",
    }).transcribe(Buffer.from("ogg-bytes"), "audio/ogg");

    expect(result.ok).toBe(true);
    expect(result.text).toBe("send 800 to opay");
    expect(result.language).toBe("en");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.deepgram.com/v1/listen?"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Token dg-test",
          "Content-Type": "audio/ogg",
        }),
      }),
    );
  });

  it("treats an empty transcript as failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: "  " }] }] },
      }),
    });
    const result = await service({ DEEPGRAM_API_KEY: "dg-test" }).transcribe(
      Buffer.from("ogg"),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("empty_transcript");
  });
});
