import { of } from "rxjs";
import { WhatsappService } from "./whatsapp.service";

describe("WhatsappService.downloadMedia", () => {
  it("still downloads inbound media when WHATSAPP_DRY_RUN is true", async () => {
    const http = {
      get: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: "https://lookaside.example/file",
              mime_type: "image/jpeg",
            },
          }),
        )
        .mockReturnValueOnce(of({ data: Buffer.from("jpeg") })),
    };
    const service = new WhatsappService(
      http as any,
      {
        get: (key: string) => {
          if (key === "WHATSAPP_DRY_RUN") return "true";
          if (key === "WHATSAPP_ACCESS_TOKEN") return "tok";
          return "";
        },
      } as any,
      { recordOutbound: jest.fn() } as any,
    );

    const result = await service.downloadMedia("media-1");
    expect(result.mimeType).toBe("image/jpeg");
    expect(http.get).toHaveBeenCalledTimes(2);
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
