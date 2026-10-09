import { OnboardingStage, Prisma } from "@prisma/client";
import { defineScenario } from "../../runner/define";
import { request } from "../../helpers/http";
import { expect, expectStatus } from "../../helpers/assert";
import { bearer, setPinDirectly, signInNewNumber } from "../../helpers/app";
import { prisma } from "../../helpers/db";

const PIN = "7351";

/** An onboarded account with a PIN, in dry run. */
async function readyToBuy(userId: string, phoneNumber: string) {
  await prisma().user.update({
    where: { id: userId },
    data: {
      rubiesAccountNumber: `33${phoneNumber.slice(-8)}`,
      rubiesAccountName: "E2E Buyer",
      onboardingStage: OnboardingStage.COMPLETE,
      flatDailyAmount: new Prisma.Decimal(50_000),
    },
  });
  await setPinDirectly(userId, PIN);
}

function key(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function quote(
  accessToken: string,
  idempotencyKey: string | undefined,
  body: Record<string, unknown>,
) {
  const headers: Record<string, string> = { ...bearer(accessToken).headers };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return request<any>("POST", "/v1/bills", body, { headers });
}

const AIRTIME = {
  category: "AIRTIME",
  billerCode: "MTN_AIRTIME",
  target: "08000000000",
  amount: 500,
};
const ELECTRICITY = {
  category: "ELECTRICITY",
  billerCode: "IKEDC",
  target: "45000000000",
  amount: 3000,
};

export default defineScenario({
  name: "app.bills.native-quote-confirm-pin",
  description:
    "Airtime, data and electricity quoted natively from the catalog; electricity goes confirm, PIN, EXECUTED with its token; a replayed key returns the same purchase; nobody else can touch it; the chat gets the result but no card or PIN form",
  tags: ["app", "money", "security"],
  async run(ctx) {
    expectStatus(await request("POST", "/v1/bills", AIRTIME), 401);

    const me = await signInNewNumber();
    await readyToBuy(me.userId, me.phoneNumber);
    const auth = bearer(me.accessToken);

    // The catalog route still answers: it is declared before :id.
    const catalog = await request<any>(
      "GET",
      "/v1/bills/catalog",
      undefined,
      auth,
    );
    expectStatus(catalog, 200);
    const bundle = catalog.body.data.networks[0].bundles[0];

    const missing = await quote(me.accessToken, undefined, AIRTIME);
    expectStatus(missing, 400);
    expect(missing.body.error).toBe("idempotency_key_required");

    // --- Airtime, and its replay ---------------------------------------------
    const k = key();
    const airtime = await quote(me.accessToken, k, AIRTIME);
    expectStatus(airtime, 201);
    expect(airtime.body.payment).toMatchObject({
      status: "awaiting_confirmation",
      category: "AIRTIME",
      provider: "MTN",
      surface: "native",
      amount: 500,
    });
    const replay = await quote(me.accessToken, k, AIRTIME);
    expectStatus(replay, 200);
    expect(replay.body.payment.id).toBe(airtime.body.payment.id);
    const reused = await quote(me.accessToken, k, { ...AIRTIME, amount: 600 });
    expectStatus(reused, 422);
    expect(reused.body.error).toBe("idempotency_key_reused");
    expect(
      await prisma().billPayment.count({
        where: { userId: me.userId, clientRequestKey: k },
      }),
    ).toBe(1);
    ctx.log("airtime: 201, replay 200 with the same purchase, reuse 422");

    // --- Data: the bundle sets the price ------------------------------------------
    const data = {
      category: "DATA",
      billerCode: catalog.body.data.networks[0].billerCode,
      productCode: bundle.productCode,
      target: "08000000000",
    };
    const priced = await quote(me.accessToken, key(), { ...data, amount: 1 });
    expectStatus(priced, 400);
    expect(priced.body.error).toBe("amount_not_allowed");
    const dataQuote = await quote(me.accessToken, key(), data);
    expectStatus(dataQuote, 201);
    expect(dataQuote.body.payment).toMatchObject({
      category: "DATA",
      amount: bundle.amount,
      product: bundle.label,
    });
    ctx.log(
      "data: priced from the catalog; an amount sent with a bundle is refused",
    );

    // --- Electricity: meter check, confirm, PIN, token -------------------------------
    const lookupsBefore = await prisma().nameEnquiryLog.count({
      where: { userId: me.userId },
    });
    const power = await quote(me.accessToken, key(), ELECTRICITY);
    expectStatus(power, 201);
    expect(power.body.payment).toMatchObject({
      category: "ELECTRICITY",
      provider: "Ikeja Electric",
      customerName: "DRY RUN CUSTOMER",
      target: "45000000000",
    });
    expect(
      await prisma().nameEnquiryLog.count({ where: { userId: me.userId } }),
    ).toBe(lookupsBefore + 1);
    const id: string = power.body.payment.id;

    // --- Somebody else ----------------------------------------------------------------
    const other = await signInNewNumber();
    const theirs = bearer(other.accessToken);
    expectStatus(
      await request("GET", `/v1/bills/${id}`, undefined, theirs),
      404,
    );
    expectStatus(
      await request("POST", `/v1/bills/${id}/confirm`, undefined, theirs),
      404,
    );
    expectStatus(
      await request(
        "POST",
        `/v1/bills/${id}/authorize`,
        { pinToken: "x", pin: PIN },
        theirs,
      ),
      404,
    );
    expectStatus(
      await request("POST", `/v1/bills/${id}/cancel`, undefined, theirs),
      404,
    );
    ctx.log("another user's session gets 404 on every route");

    const confirmed = await request<any>(
      "POST",
      `/v1/bills/${id}/confirm`,
      undefined,
      auth,
    );
    expectStatus(confirmed, 200);
    expect(confirmed.body.decision).toBe("pin_required");

    const bought = await request<any>(
      "POST",
      `/v1/bills/${id}/authorize`,
      { pinToken: confirmed.body.pinToken, pin: PIN },
      auth,
    );
    expectStatus(bought, 200);
    expect(bought.body.result).toBe("successful");
    expect(typeof bought.body.payment.token).toBe("string");
    const row = await prisma().billPayment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("EXECUTED");
    expect(row.originSurface).toBe("NATIVE");
    expect(row.originChannel).toBe("APP");
    ctx.log(
      "electricity: meter checked, confirm, PIN, EXECUTED with its token",
    );

    // --- What the chat saw -----------------------------------------------------------
    const chat = await prisma().appMessage.findMany({
      where: { userId: me.userId, direction: "OUTBOUND" },
    });
    expect(
      chat.filter((m) => m.kind === "BUTTONS" || m.kind === "FORM_REQUEST"),
    ).toHaveLength(0);
    expect(chat.some((m) => /Token:/.test(m.body ?? ""))).toBe(true);
    ctx.log("the app chat has the result and token, and no card or PIN form");

    // --- Cancel ---------------------------------------------------------------------
    const cancelled = await request<any>(
      "POST",
      `/v1/bills/${airtime.body.payment.id}/cancel`,
      undefined,
      auth,
    );
    expectStatus(cancelled, 200);
    expect(cancelled.body.status).toBe("cancelled");
    expectStatus(
      await request("POST", `/v1/bills/${id}/cancel`, undefined, auth),
      409,
    );
    ctx.log("a quote can be cancelled; nothing past the PIN can");
  },
});
