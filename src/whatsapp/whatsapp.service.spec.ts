import { of } from "rxjs";
import { WhatsappService } from "./whatsapp.service";

describe("WhatsappService.downloadMedia", () => {
  it("skips the network when WHATSAPP_DRY_RUN is true", async () => {
    const http = { get: jest.fn() };
    const service = new WhatsappService(
      http as any,
      {
        get: (key: string) => (key === "WHATSAPP_DRY_RUN" ? "true" : ""),
      } as any,
      { recordOutbound: jest.fn() } as any,
    );

    await expect(service.downloadMedia("media-1")).rejects.toThrow(/DRY_RUN/);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("fetches the Meta URL then the bytes", async () => {
    const http = {
      get: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: "https://lookaside.example/file",
              mime_type: "audio/ogg",
            },
          }),
        )
        .mockReturnValueOnce(of({ data: Buffer.from("ogg-bytes") })),
    };

    const service = new WhatsappService(
      http as any,
      {
        get: (key: string) => {
          if (key === "WHATSAPP_DRY_RUN") return "false";
          if (key === "WHATSAPP_ACCESS_TOKEN") return "tok";
          return "";
        },
      } as any,
      { recordOutbound: jest.fn() } as any,
    );

    const result = await service.downloadMedia("media-1");
    expect(result.mimeType).toBe("audio/ogg");
    expect(result.buffer.toString()).toBe("ogg-bytes");
    expect(http.get).toHaveBeenCalledTimes(2);
  });
});
