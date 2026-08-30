import { of, throwError } from "rxjs";
import { EmailService } from "./email.service";
import { EmailStatus, EmailType, Prisma } from "@prisma/client";

describe("EmailService", () => {
  let prisma: { emailLog: { create: jest.Mock; update: jest.Mock } };
  let config: { get: jest.Mock };
  let http: { post: jest.Mock };
  let service: EmailService;

  const base = {
    userId: "user-1",
    to: "me@example.com",
    type: EmailType.MONEY_IN,
    subject: "money in",
    html: "<p>hi</p>",
    dedupeKey: "MONEY_IN:ref-1",
  };

  /** The status the log row was finalized with. */
  function finalizedWith() {
    return prisma.emailLog.update.mock.calls[0]?.[0]?.data;
  }

  beforeEach(() => {
    prisma = {
      emailLog: {
        create: jest.fn().mockResolvedValue({ id: "log-1" }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    config = {
      get: jest.fn((key: string) =>
        key === "RESEND_API_KEY" ? "re_test_key" : undefined,
      ),
    };
    http = { post: jest.fn().mockReturnValue(of({ data: { id: "msg-1" } })) };
    service = new EmailService(prisma as any, config as any, http as any);
  });

  it("posts to Resend and records the provider id", async () => {
    const result = await service.send(base);

    expect(result).toEqual({ sent: true, providerId: "msg-1" });
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(body).toMatchObject({
      to: ["me@example.com"],
      subject: "money in",
      html: "<p>hi</p>",
    });
    expect(opts.headers.Authorization).toBe("Bearer re_test_key");
    expect(finalizedWith()).toMatchObject({
      status: EmailStatus.SENT,
      providerId: "msg-1",
    });
  });

  it("claims the dedupe key BEFORE calling Resend, so a race can't double-send", async () => {
    await service.send(base);

    const createOrder = prisma.emailLog.create.mock.invocationCallOrder[0];
    const postOrder = http.post.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(postOrder);
  });

  it("refuses a duplicate without calling Resend when the key is already claimed", async () => {
    prisma.emailLog.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dupe", {
        code: "P2002",
        clientVersion: "5.22.0",
        meta: { target: ["dedupeKey"] },
      }),
    );

    const result = await service.send(base);

    expect(result).toEqual({ sent: false, reason: "duplicate" });
    expect(http.post).not.toHaveBeenCalled();
  });

  it("skips, and records why, when the user has no email address", async () => {
    const result = await service.send({ ...base, to: null });

    expect(result).toEqual({ sent: false, reason: "no_address" });
    expect(http.post).not.toHaveBeenCalled();
    expect(finalizedWith()).toMatchObject({ status: EmailStatus.SKIPPED });
  });

  it("skips loudly rather than crashing when RESEND_API_KEY is unset", async () => {
    config.get.mockReturnValue(undefined);

    const result = await service.send(base);

    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(http.post).not.toHaveBeenCalled();
    expect(finalizedWith()).toMatchObject({ status: EmailStatus.SKIPPED });
  });

  it("never throws when Resend fails, and records the error for diagnosis", async () => {
    http.post.mockReturnValue(
      throwError(() => ({
        response: { status: 422, data: { message: "invalid from address" } },
      })),
    );

    const result = await service.send(base);

    expect(result).toEqual({ sent: false, reason: "error" });
    expect(finalizedWith()).toMatchObject({ status: EmailStatus.FAILED });
    expect(finalizedWith().error).toContain("invalid from address");
  });

  it("does not propagate a bookkeeping failure after a successful send", async () => {
    prisma.emailLog.update.mockRejectedValue(new Error("db down"));

    await expect(service.send(base)).resolves.toEqual({
      sent: true,
      providerId: "msg-1",
    });
  });

  it("uses the configured from-address when one is set", async () => {
    config.get.mockImplementation((key: string) =>
      key === "RESEND_API_KEY"
        ? "re_test_key"
        : key === "RESEND_FROM_ADDRESS"
          ? "Udara <hello@udara.ng>"
          : undefined,
    );

    await service.send(base);

    expect(http.post.mock.calls[0][1].from).toBe("Udara <hello@udara.ng>");
  });
});
