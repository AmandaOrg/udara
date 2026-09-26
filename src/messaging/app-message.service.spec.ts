import { Prisma } from "@prisma/client";
import { AppMessageService, PAGE_SIZE } from "./app-message.service";
import { AppMessageNotifier } from "./app-message.notifier";

describe("AppMessageService", () => {
  let prisma: {
    appMessage: {
      create: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let notifier: { notify: jest.Mock };
  let service: AppMessageService;

  beforeEach(() => {
    prisma = {
      appMessage: {
        create: jest.fn(async ({ data }) => ({ id: "m1", seq: 7n, ...data })),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(async ({ data }) => ({
          id: "m1",
          userId: "user-1",
          ...data,
        })),
      },
    };
    notifier = { notify: jest.fn() };
    service = new AppMessageService(prisma as any, notifier as any);
  });

  describe("inbound", () => {
    /**
     * Someone whose PIN form did not open types the PIN into the chat. Once the
     * row exists nothing can take it back, so the scrub is on the way in.
     */
    it("scrubs a labelled PIN or BVN before the text is stored", async () => {
      await service.recordInbound("user-1", {
        clientMessageId: "c-00000001",
        kind: "TEXT",
        body: "my pin is 4821 and my bvn is 22123456789",
      });

      const stored = prisma.appMessage.create.mock.calls[0][0].data;
      expect(stored.body).not.toContain("4821");
      expect(stored.body).not.toContain("22123456789");
      expect(stored.body).toContain("[redacted]");
      expect(stored.status).toBe("RECEIVED");
      expect(stored.direction).toBe("INBOUND");
    });

    it("leaves a bare phone number alone, which is how airtime is bought", async () => {
      await service.recordInbound("user-1", {
        clientMessageId: "c-00000002",
        kind: "TEXT",
        body: "airtime 500 to 08031234567",
      });

      expect(prisma.appMessage.create.mock.calls[0][0].data.body).toBe(
        "airtime 500 to 08031234567",
      );
    });

    it("returns the original row, not a new one, for a retried send", async () => {
      prisma.appMessage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "5",
        }),
      );
      prisma.appMessage.findUniqueOrThrow.mockResolvedValue({ id: "original" });

      const result = await service.recordInbound("user-1", {
        clientMessageId: "c-00000003",
        kind: "TEXT",
        body: "hi",
      });

      expect(result).toEqual({ row: { id: "original" }, isNew: false });
      expect(prisma.appMessage.findUniqueOrThrow).toHaveBeenCalledWith({
        where: {
          userId_clientMessageId: {
            userId: "user-1",
            clientMessageId: "c-00000003",
          },
        },
      });
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("lets any other database error through", async () => {
      prisma.appMessage.create.mockRejectedValue(new Error("connection lost"));

      await expect(
        service.recordInbound("user-1", {
          clientMessageId: "c-00000004",
          kind: "START",
        }),
      ).rejects.toThrow("connection lost");
    });
  });

  describe("outbound", () => {
    it("stores what a form request offered, and wakes the user's polls", async () => {
      await service.recordOutbound("user-1", {
        kind: "FORM_REQUEST",
        form: {
          kind: "KYC",
          token: "tok",
          headerText: "Verify your identity",
          bodyText: "Takes under a minute.",
          ctaText: "Verify identity",
        },
      });

      expect(prisma.appMessage.create).toHaveBeenCalledWith({
        data: {
          userId: "user-1",
          direction: "OUTBOUND",
          kind: "FORM_REQUEST",
          body: "Takes under a minute.",
          payload: {
            form: "KYC",
            token: "tok",
            headerText: "Verify your identity",
            bodyText: "Takes under a minute.",
            ctaText: "Verify identity",
          },
        },
      });
      expect(notifier.notify).toHaveBeenCalledWith("user-1");
    });
  });

  describe("which choices were offered", () => {
    const offer = {
      id: "m-offer",
      payload: {
        buttons: [
          { id: "intro:yes", title: "Yes, I understand" },
          { id: "intro:no", title: "No, explain more" },
        ],
      },
    };

    it("finds only the caller's own outbound buttons or list message", async () => {
      prisma.appMessage.findFirst.mockResolvedValue(offer);

      await expect(
        service.findOfferedChoice("user-1", "m-offer", "intro:yes"),
      ).resolves.toBe("Yes, I understand");
      expect(prisma.appMessage.findFirst).toHaveBeenCalledWith({
        where: {
          id: "m-offer",
          userId: "user-1",
          direction: "OUTBOUND",
          kind: { in: ["BUTTONS", "LIST"] },
        },
      });
    });

    it("refuses an id the message did not offer", async () => {
      prisma.appMessage.findFirst.mockResolvedValue(offer);

      await expect(
        service.findOfferedChoice("user-1", "m-offer", "confirm:txn-9"),
      ).resolves.toBeNull();
    });

    it("refuses a message that is not the caller's, or not there", async () => {
      prisma.appMessage.findFirst.mockResolvedValue(null);

      await expect(
        service.findOfferedChoice("user-1", "m-someone-else", "intro:yes"),
      ).resolves.toBeNull();
    });

    it("reads list rows as well as buttons", async () => {
      prisma.appMessage.findFirst.mockResolvedValue({
        payload: {
          buttonLabel: "Pick",
          rows: [{ id: "sq1:a", title: "Rarely" }],
        },
      });

      await expect(
        service.findOfferedChoice("user-1", "m-list", "sq1:a"),
      ).resolves.toBe("Rarely");
    });
  });

  describe("reading", () => {
    it("reads forward from a cursor, oldest first", async () => {
      await service.list("user-1", 41n);

      expect(prisma.appMessage.findMany).toHaveBeenCalledWith({
        where: { userId: "user-1", seq: { gt: 41n } },
        orderBy: { seq: "asc" },
        take: PAGE_SIZE,
      });
    });

    it("with no cursor, returns the latest page in reading order", async () => {
      prisma.appMessage.findMany.mockResolvedValue([{ seq: 3n }, { seq: 2n }]);

      const rows = await service.list("user-1");

      expect(prisma.appMessage.findMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        orderBy: { seq: "desc" },
        take: PAGE_SIZE,
      });
      expect(rows.map((r) => r.seq)).toEqual([2n, 3n]);
    });
  });

  it("wakes polls when a message finishes, so the app can stop showing it as in progress", async () => {
    await service.markProcessed("m1", "PROCESSED");

    expect(prisma.appMessage.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { status: "PROCESSED", processedAt: expect.any(Date) },
    });
    expect(notifier.notify).toHaveBeenCalledWith("user-1");
  });
});

describe("AppMessageNotifier", () => {
  it("wakes a waiting poll for that user only", async () => {
    const notifier = new AppMessageNotifier();
    const mine = notifier.wait("user-1", 5_000);
    const theirs = notifier.wait("user-2", 20);

    notifier.notify("user-1");

    await expect(mine).resolves.toBe(true);
    await expect(theirs).resolves.toBe(false);
  });
});
