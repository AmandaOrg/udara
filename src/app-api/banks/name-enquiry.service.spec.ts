import { HttpException } from "@nestjs/common";
import { LOOKUPS_PER_HOUR, NameEnquiryService } from "./name-enquiry.service";

function build(hasAccount = true) {
  let rows: { id: string; userId: string; createdAt: Date }[] = [];
  let next = 0;
  const log = {
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `row-${next++}`, ...data };
      rows.push(row);
      return { id: row.id };
    }),
    count: jest.fn(
      async ({ where }: any) =>
        rows.filter(
          (r) => r.userId === where.userId && r.createdAt > where.createdAt.gt,
        ).length,
    ),
    deleteMany: jest.fn(async ({ where }: any) => {
      rows = rows.filter(
        (r) =>
          !(r.userId === where.userId && r.createdAt <= where.createdAt.lte),
      );
    }),
    delete: jest.fn(async ({ where }: any) => {
      rows = rows.filter((r) => r.id !== where.id);
    }),
  };
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        rubiesAccountNumber: hasAccount ? "0000000009" : null,
      }),
    },
    nameEnquiryLog: log,
  };
  const rubies = {
    nameEnquiry: jest
      .fn()
      .mockResolvedValue({ accountName: "ADA OKAFOR", bankName: "Access" }),
  };
  return {
    rows: () => rows,
    log,
    rubies,
    service: new NameEnquiryService(prisma as any, rubies as any),
  };
}

const t0 = new Date("2026-09-26T10:00:00Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

describe("NameEnquiryService", () => {
  it("returns the account name", async () => {
    const { service, rubies } = build();
    await expect(
      service.lookup("me", "0000000001", "000005", t0),
    ).resolves.toEqual({ accountName: "ADA OKAFOR" });
    expect(rubies.nameEnquiry).toHaveBeenCalledWith({
      accountNumber: "0000000001",
      bankCode: "000005",
    });
  });

  it(`refuses the ${LOOKUPS_PER_HOUR + 1}st lookup in an hour, and allows it again once the first ages out`, async () => {
    const { service, rubies } = build();
    for (let i = 0; i < LOOKUPS_PER_HOUR; i++) {
      expect(
        await status(service.lookup("me", "0000000001", "000005", minutes(i))),
      ).toBe("ok");
    }

    expect(
      await status(service.lookup("me", "0000000001", "000005", minutes(30))),
    ).toBe(429);
    expect(rubies.nameEnquiry).toHaveBeenCalledTimes(LOOKUPS_PER_HOUR);

    // Minute 0's lookup is more than an hour old at 60m + 1s.
    expect(
      await status(
        service.lookup(
          "me",
          "0000000001",
          "000005",
          new Date(minutes(60).getTime() + 1_000),
        ),
      ),
    ).toBe("ok");
  });

  it("stores who and when, never the account looked up", async () => {
    const { service, log } = build();
    await service.lookup("me", "0000000001", "000005", t0);
    const data = log.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["createdAt", "userId"]);
  });

  it("does not keep rows older than the hour", async () => {
    const { service, rows } = build();
    await service.lookup("me", "0000000001", "000005", t0);
    await service.lookup("me", "0000000001", "000005", minutes(90));
    expect(rows().map((r) => r.createdAt)).toEqual([minutes(90)]);
  });

  it("needs an opened account, and does not count that refusal", async () => {
    const { service, log, rubies } = build(false);
    expect(await status(service.lookup("me", "0000000001", "000005", t0))).toBe(
      409,
    );
    expect(log.create).not.toHaveBeenCalled();
    expect(rubies.nameEnquiry).not.toHaveBeenCalled();
  });

  it("answers 422 when Rubies cannot resolve it, and that still counts", async () => {
    const { service, rubies, rows } = build();
    rubies.nameEnquiry.mockRejectedValue(new Error("Invalid account"));
    expect(await status(service.lookup("me", "0000000001", "000005", t0))).toBe(
      422,
    );
    expect(rows()).toHaveLength(1);
  });
});
