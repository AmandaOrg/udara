import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import {
  decodeCursor,
  encodeCursor,
  TransactionHistoryService,
} from "./transaction-history.service";

type Row = Record<string, any>;

/**
 * Just enough of Prisma's findMany for the history: userId, status in, the
 * cursor's OR, (time desc, id desc) ordering and take.
 */
function table(rows: Row[], timeField: string) {
  return {
    findMany: jest.fn(async (args: any) => {
      const { where, take } = args;
      const cursorOr: any[] | undefined = where.OR;
      return rows
        .filter((r) => r.userId === where.userId)
        .filter((r) => !where.status || where.status.in.includes(r.status))
        .filter(
          (r) =>
            !cursorOr ||
            r[timeField] < cursorOr[0][timeField].lt ||
            (r[timeField].getTime() === cursorOr[1][timeField].getTime() &&
              r.id < cursorOr[1].id.lt),
        )
        .sort((a, b) =>
          b[timeField] - a[timeField] !== 0
            ? b[timeField] - a[timeField]
            : a.id < b.id
              ? 1
              : -1,
        )
        .slice(0, take);
    }),
  };
}

const recipient = {
  accountName: "ADA OKAFOR",
  nickname: null,
  accountNumber: "0000000001",
  bankCode: "000005",
  label: "FOOD",
};

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 8, 20, 10, minute));
}

function transfer(userId: string, minute: number, status = "EXECUTED"): Row {
  return {
    id: randomUUID(),
    userId,
    status,
    amount: new Prisma.Decimal("1500.00"),
    feeAmount: new Prisma.Decimal("0"),
    type: "NORMAL",
    purposeLabel: null,
    createdAt: at(minute),
    recipient,
  };
}

function bill(userId: string, minute: number, status = "EXECUTED"): Row {
  return {
    id: randomUUID(),
    userId,
    status,
    category: "ELECTRICITY",
    telcoLabel: "Ikeja Electric",
    productLabel: null,
    msisdn: "00000000000",
    customerName: "A OKAFOR",
    vendorToken: "1111-2222-3333",
    amount: new Prisma.Decimal("5000"),
    feeAmount: new Prisma.Decimal("250"),
    type: "EARLY_ACCESS",
    createdAt: at(minute),
  };
}

function credit(userId: string, minute: number): Row {
  return {
    id: randomUUID(),
    userId,
    amount: new Prisma.Decimal("20000"),
    sourceNarration: "salary",
    creditedAt: at(minute),
  };
}

function build(rows: { transfers: Row[]; bills: Row[]; credits: Row[] }) {
  const prisma = {
    transaction: table(rows.transfers, "createdAt"),
    billPayment: table(rows.bills, "createdAt"),
    incomingCredit: table(rows.credits, "creditedAt"),
  };
  const banks = {
    names: jest.fn().mockResolvedValue(new Map([["000005", "Access Bank"]])),
  };
  return {
    prisma,
    banks,
    service: new TransactionHistoryService(prisma as any, banks as any),
  };
}

describe("TransactionHistoryService", () => {
  it("merges the three sources newest first, and only the caller's rows", async () => {
    const { service } = build({
      transfers: [transfer("me", 1), transfer("other", 5)],
      bills: [bill("me", 3), bill("other", 6)],
      credits: [credit("me", 2), credit("other", 7)],
    });

    const page = await service.page("me");

    expect(page.items.map((i) => [i.kind, i.occurredAt])).toEqual([
      ["bill", at(3).toISOString()],
      ["credit", at(2).toISOString()],
      ["transfer", at(1).toISOString()],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves out quotes and cancellations, and shows what is in flight", async () => {
    const { service } = build({
      transfers: [
        transfer("me", 1, "PENDING_CONFIRMATION"),
        transfer("me", 2, "PENDING_PIN"),
        transfer("me", 3, "CANCELLED"),
        transfer("me", 4, "CONFIRMED"),
        transfer("me", 5, "FAILED"),
      ],
      bills: [bill("me", 6, "CANCELLED"), bill("me", 7, "PENDING_PIN")],
      credits: [],
    });

    const page = await service.page("me");

    expect(page.items.map((i) => i.status)).toEqual(["failed", "processing"]);
  });

  it("pages through everything with no gaps or repeats, same-millisecond rows included", async () => {
    const transfers = [1, 2, 2, 2, 4, 6, 8, 8].map((m) => transfer("me", m));
    const bills = [2, 3, 5, 8, 9].map((m) => bill("me", m));
    const credits = [2, 7, 8, 10, 11].map((m) => credit("me", m));
    const { service } = build({ transfers, bills, credits });
    const expected = [...transfers, ...bills, ...credits]
      .map((r) => ({ id: r.id, t: (r.createdAt ?? r.creditedAt).getTime() }))
      .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1))
      .map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await service.page(
        "me",
        cursor ? decodeCursor(cursor)! : undefined,
        4,
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);

    expect(seen).toEqual(expected);
  });

  it("shows an electricity token only once the purchase went through", async () => {
    const { service } = build({
      transfers: [],
      bills: [bill("me", 1, "CONFIRMED"), bill("me", 2, "EXECUTED")],
      credits: [],
    });

    const [done, pending] = (await service.page("me")).items;

    expect(done.bill?.token).toBe("1111-2222-3333");
    expect(pending.bill?.token).toBeNull();
    expect(done.title).toBe("Ikeja Electric");
    expect(done.fee).toBe(250);
  });

  it("names the recipient's bank, and asks for bank names only when there are transfers", async () => {
    const withTransfer = build({
      transfers: [transfer("me", 1)],
      bills: [],
      credits: [],
    });
    const [item] = (await withTransfer.service.page("me")).items;
    expect(item.transfer).toMatchObject({
      bankName: "Access Bank",
      purpose: "FOOD",
    });
    expect(item.title).toBe("ADA OKAFOR");

    const creditsOnly = build({
      transfers: [],
      bills: [],
      credits: [credit("me", 1)],
    });
    await creditsOnly.service.page("me");
    expect(creditsOnly.banks.names).not.toHaveBeenCalled();
  });

  it("caps the page size", async () => {
    const { service, prisma } = build({
      transfers: [],
      bills: [],
      credits: [],
    });
    await service.page("me", undefined, 500);
    expect(prisma.transaction.findMany.mock.calls[0][0].take).toBe(50);
  });
});

describe("history cursor", () => {
  it("round-trips", () => {
    const cursor = { at: at(3), id: randomUUID() };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64", "!!!"],
    ["not a cursor", Buffer.from("hello").toString("base64url")],
    ["an id that is not a uuid", Buffer.from("123.abc").toString("base64url")],
    [
      "an injected id",
      Buffer.from(`1.${randomUUID()}' OR 1=1`).toString("base64url"),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});
