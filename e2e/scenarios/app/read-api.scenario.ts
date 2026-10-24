import {
  BillPaymentCategory,
  BillPaymentStatus,
  OnboardingStage,
  Prisma,
  TransactionStatus,
} from "@prisma/client";
import { defineScenario } from "../../runner/define";
import { request } from "../../helpers/http";
import { expect, expectStatus } from "../../helpers/assert";
import {
  bearer,
  signInNewNumber,
  uniqueNigerianMobile,
} from "../../helpers/app";
import { prisma } from "../../helpers/db";

const SIGNED_IN_ROUTES: [string, string, unknown?][] = [
  ["GET", "/v1/balance"],
  ["GET", "/v1/limits"],
  ["GET", "/v1/account"],
  ["GET", "/v1/transactions"],
  ["GET", "/v1/recipients"],
  ["GET", "/v1/banks"],
  [
    "POST",
    "/v1/name-enquiry",
    { accountNumber: "0000000001", bankCode: "000005" },
  ],
  ["GET", "/v1/spend-summary"],
  ["GET", "/v1/bills/catalog"],
];

/** An opened account with a plan, so the figures can be computed. */
async function openAccount(userId: string, phoneNumber: string) {
  const accountNumber = `55${phoneNumber.slice(-8)}`;
  await prisma().user.update({
    where: { id: userId },
    data: {
      rubiesAccountNumber: accountNumber,
      rubiesAccountName: "E2E Reader",
      onboardingStage: OnboardingStage.COMPLETE,
      flatDailyAmount: new Prisma.Decimal(5000),
    },
  });
}

/** One of each history row, plus a quote and a cancellation that must not show. */
async function seedHistory(userId: string, tag: string) {
  const recipient = await prisma().recipient.create({
    data: {
      userId,
      accountNumber: `00000${Math.floor(Math.random() * 1e5)
        .toString()
        .padStart(5, "0")}`,
      bankCode: "000005",
      accountName: `E2E PAYEE ${tag}`,
      label: "FOOD",
    },
  });
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const shown = [
    await prisma().transaction.create({
      data: {
        userId,
        recipientId: recipient.id,
        amount: new Prisma.Decimal(1200),
        status: TransactionStatus.EXECUTED,
        createdAt: minutesAgo(5),
      },
    }),
    await prisma().billPayment.create({
      data: {
        userId,
        category: BillPaymentCategory.AIRTIME,
        billerCode: "MTN_AIRTIME",
        productCode: "MTN_AIRTIME_PREPAID",
        telcoLabel: "MTN",
        msisdn: "08000000000",
        amount: new Prisma.Decimal(500),
        status: BillPaymentStatus.EXECUTED,
        createdAt: minutesAgo(4),
      },
    }),
    await prisma().incomingCredit.create({
      data: {
        userId,
        amount: new Prisma.Decimal(9000),
        rubiesReference: `e2e-read-${tag}-${Date.now()}-${Math.random()}`,
        sourceNarration: `E2E credit ${tag}`,
        creditedAt: minutesAgo(3),
      },
    }),
  ];
  const hidden = [
    await prisma().transaction.create({
      data: {
        userId,
        recipientId: recipient.id,
        amount: new Prisma.Decimal(700),
        status: TransactionStatus.PENDING_CONFIRMATION,
        createdAt: minutesAgo(2),
      },
    }),
    await prisma().transaction.create({
      data: {
        userId,
        recipientId: recipient.id,
        amount: new Prisma.Decimal(800),
        status: TransactionStatus.CANCELLED,
        createdAt: minutesAgo(1),
      },
    }),
  ];
  return {
    recipientId: recipient.id,
    shown: shown.map((r) => r.id),
    hidden: hidden.map((r) => r.id),
  };
}

export default defineScenario({
  name: "app.read.own-data-only",
  description:
    "The read-only screens need a session (app-config aside), answer 409 before the account exists, and show only the caller's own rows",
  tags: ["app", "security"],
  async run(ctx) {
    for (const [method, path, body] of SIGNED_IN_ROUTES) {
      expectStatus(await request(method as any, path, body), 401);
    }
    const config = await request<any>("GET", "/v1/app-config");
    expectStatus(config, 200);
    expect(config.body).toHaveProperty("minSupportedVersion");
    ctx.log("every read route is 401 without a session; app-config is public");

    const me = await signInNewNumber();
    const auth = bearer(me.accessToken);

    const before = await request<any>("GET", "/v1/me", undefined, auth);
    expect(before.body.hasAccount).toBe(false);
    for (const path of ["/v1/balance", "/v1/limits", "/v1/account"]) {
      const res = await request<any>("GET", path, undefined, auth);
      expectStatus(res, 409);
      expect(res.body.error).toBe("no_account");
    }
    expectStatus(
      await request("POST", "/v1/name-enquiry", SIGNED_IN_ROUTES[6][2], auth),
      409,
    );
    const empty = await request<any>(
      "GET",
      "/v1/transactions",
      undefined,
      auth,
    );
    expect(empty.body).toEqual({ items: [], nextCursor: null });
    ctx.log("before the account: 409 on the figures, an empty history");

    await openAccount(me.userId, me.phoneNumber);
    const mine = await seedHistory(me.userId, "mine");

    // Someone else, with the same kinds of rows.
    const otherPhone = uniqueNigerianMobile();
    const other = await prisma().user.create({
      data: { phoneNumber: otherPhone },
    });
    const theirs = await seedHistory(other.id, "theirs");

    const balance = await request<any>("GET", "/v1/balance", undefined, auth);
    expectStatus(balance, 200);
    expect(typeof balance.body.balance).toBe("number");

    const account = await request<any>("GET", "/v1/account", undefined, auth);
    expect(account.body).toMatchObject({
      accountNumber: `55${me.phoneNumber.slice(-8)}`,
      bankName: "Rubies MFB",
    });

    const limits = await request<any>("GET", "/v1/limits", undefined, auth);
    expectStatus(limits, 200);
    expect(typeof limits.body.window.open).toBe("boolean");
    ctx.log("balance, account and limits for the caller");

    // Page through the history two at a time.
    const seen: any[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const page = await request<any>(
        "GET",
        `/v1/transactions${query}`,
        undefined,
        auth,
      );
      expectStatus(page, 200);
      seen.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.map((i) => i.kind)).toEqual(["credit", "bill", "transfer"]);
    expect(seen.map((i) => i.id).sort()).toEqual([...mine.shown].sort());
    for (const id of [...mine.hidden, ...theirs.shown, ...theirs.hidden]) {
      expect(seen.map((i) => i.id)).not.toContain(id);
    }
    ctx.log("history: own rows only, newest first, no quotes or cancellations");

    expectStatus(
      await request(
        "GET",
        "/v1/transactions?cursor=bm90LWEtY3Vyc29y",
        undefined,
        auth,
      ),
      400,
    );

    const recipients = await request<any>(
      "GET",
      "/v1/recipients",
      undefined,
      auth,
    );
    expect(recipients.body.recipients.map((r: any) => r.id)).toEqual([
      mine.recipientId,
    ]);

    const summary = await request<any>(
      "GET",
      "/v1/spend-summary",
      undefined,
      auth,
    );
    expectStatus(summary, 200);
    expect(summary.body.period).toBe("week");

    const banks = await request<any>("GET", "/v1/banks", undefined, auth);
    expectStatus(banks, 200);
    expect(banks.body.banks.length).toBeGreaterThan(0);

    const lookup = await request<any>(
      "POST",
      "/v1/name-enquiry",
      SIGNED_IN_ROUTES[6][2],
      auth,
    );
    expectStatus(lookup, 200);
    expect(typeof lookup.body.accountName).toBe("string");
    expect(
      await prisma().nameEnquiryLog.count({ where: { userId: me.userId } }),
    ).toBe(1);

    const catalog = await request<any>(
      "GET",
      "/v1/bills/catalog",
      undefined,
      auth,
    );
    expect(catalog.body.airtime.networks.length).toBeGreaterThan(0);
    ctx.log("recipients, spend summary, banks, name enquiry and the catalog");
  },
});
