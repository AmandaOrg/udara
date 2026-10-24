import { Logger } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { maskPhone, SmsService } from "./sms.service";

describe("SmsService", () => {
  let http: { post: jest.Mock };
  let env: Record<string, string>;
  let dryRun: boolean;
  let service: SmsService;
  let logs: string[];

  beforeEach(() => {
    http = { post: jest.fn() };
    env = {
      TERMII_API_KEY: "tk_secret",
      TERMII_SENDER_ID: "Udara",
    };
    dryRun = false;
    logs = [];
    for (const level of ["log", "warn", "error"] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logs.push(String(msg)));
    }
    service = new SmsService(
      http as any,
      { get: (key: string, fallback?: string) => env[key] ?? fallback } as any,
      {
        get smsDryRun() {
          return dryRun;
        },
      } as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it("sends on Termii's transactional route with the approved sender id", async () => {
    http.post.mockReturnValue(of({ data: { message_id: "m-1" } }));

    const sent = await service.send("2348012345678", "your code is 123456");

    expect(sent).toBe(true);
    expect(http.post).toHaveBeenCalledWith(
      "https://api.ng.termii.com/api/sms/send",
      {
        api_key: "tk_secret",
        to: "2348012345678",
        from: "Udara",
        sms: "your code is 123456",
        type: "plain",
        channel: "dnd",
      },
    );
  });

  it("reports a send Termii did not accept", async () => {
    http.post.mockReturnValue(
      of({ data: { message: "Insufficient balance" } }),
    );

    expect(await service.send("2348012345678", "code")).toBe(false);
  });

  /**
   * The message is the sign-in code, and Axios errors carry the request body
   * and the API key. Neither may reach a log line.
   */
  it("never logs the message or the API key, even when the request fails", async () => {
    http.post.mockReturnValue(
      throwError(() => ({
        response: { status: 401 },
        config: { data: '{"api_key":"tk_secret","sms":"123456"}' },
      })),
    );

    expect(await service.send("2348012345678", "your code is 123456")).toBe(
      false,
    );
    const everything = logs.join("\n");
    expect(everything).toContain("401");
    expect(everything).not.toContain("123456");
    expect(everything).not.toContain("tk_secret");
    expect(everything).not.toContain("2348012345678");
  });

  it("sends nothing in dry-run and says so without the message", async () => {
    dryRun = true;

    expect(await service.send("2348012345678", "your code is 123456")).toBe(
      true,
    );
    expect(http.post).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("123456");
  });

  it("masks phone numbers to their last four digits", () => {
    expect(maskPhone("2348012345678")).toBe("…5678");
  });
});
