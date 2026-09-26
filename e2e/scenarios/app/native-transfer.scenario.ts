import { OnboardingStage, Prisma } from "@prisma/client";
import { defineScenario } from "../../runner/define";
import { request } from "../../helpers/http";
import { expect, expectStatus } from "../../helpers/assert";
import { bearer, setPinDirectly, signInNewNumber } from "../../helpers/app";
import { prisma } from "../../helpers/db";

const PIN = "4816";

/** An onboarded, funded-in-dry-run account with a PIN. */
async function readyToSend(userId: string, phoneNumber: string) {
  await prisma().user.update({
    where: { id: userId },
    data: {
      rubiesAccountNumber: `44${phoneNumber.slice(-8)}`,
      rubiesAccountName: "E2E Sender",
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
  amount = 1500,
) {
  const headers: Record<string, string> = {
    ...bearer(accessToken).headers,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return request<any>(
    "POST",
    "/v1/transfers",
    {
      accountNumber: "0000000001",
      bankCode: "000005",
      amount,
      purpose: "FOOD",
    },
    { headers },
  );
}

export default defineScenario({
  name: "app.transfer.native-quote-confirm-pin",
  description:
    "A native transfer goes quote, confirm, PIN, EXECUTED; a replayed key returns the same transfer; a wrong PIN gets a fresh token; nobody else can touch it; the chat gets the result but no card or PIN form",
  tags: ["app", "money", "security"],
  async run(ctx) {
    expectStatus(
      await request("POST", "/v1/transfers", {
        accountNumber: "0000000001",
        bankCode: "000005",
        amount: 1500,
      }),
      401,
    );

    const me = await signInNewNumber();
    await readyToSend(me.userId, me.phoneNumber);
    const auth = bearer(me.accessToken);

    const missing = await quote(me.accessToken, undefined);
    expectStatus(missing, 400);
    expect(missing.body.error).toBe("idempotency_key_required");

    // --- Quote, and its replay --------------------------------------------
    const k = key();
    const first = await quote(me.accessToken, k);
    expectStatus(first, 201);
    const id: string = first.body.transfer.id;
    expect(first.body.transfer).toMatchObject({
      status: "awaiting_confirmation",
      surface: "native",
      amount: 1500,
    });

    const replay = await quote(me.accessToken, k);
    expectStatus(replay, 200);
    expect(replay.body.transfer.id).toBe(id);
    expect(
      await prisma().transaction.count({
        where: { userId: me.userId, clientRequestKey: k },
      }),
    ).toBe(1);

    const reused = await quote(me.accessToken, k, 2500);
    expectStatus(reused, 422);
    expect(reused.body.error).toBe("idempotency_key_reused");
    ctx.log(
      "quote: 201, replay 200 with the same transfer, a changed request under the key 422",
    );

    // --- Somebody else ------------------------------------------------------
    const other = await signInNewNumber();
    const theirs = bearer(other.accessToken);
    expectStatus(
      await request("GET", `/v1/transfers/${id}`, undefined, theirs),
      404,
    );
    expectStatus(
      await request("POST", `/v1/transfers/${id}/confirm`, undefined, theirs),
      404,
    );
    expectStatus(
      await request(
        "POST",
        `/v1/transfers/${id}/authorize`,
        { pinToken: "x", pin: PIN },
        theirs,
      ),
      404,
    );
    expectStatus(
      await request("POST", `/v1/transfers/${id}/cancel`, undefined, theirs),
      404,
    );
    ctx.log("another user's session gets 404 on every route");

    // --- Confirm, a wrong PIN, then the right one -----------------------------
    const confirmed = await request<any>(
      "POST",
      `/v1/transfers/${id}/confirm`,
      undefined,
      auth,
    );
    expectStatus(confirmed, 200);
    expect(confirmed.body.decision).toBe("pin_required");
    expect(confirmed.body.transfer.status).toBe("awaiting_pin");

    const wrong = await request<any>(
      "POST",
      `/v1/transfers/${id}/authorize`,
      { pinToken: confirmed.body.pinToken, pin: "0000" },
      auth,
    );
    expectStatus(wrong, 200);
    expect(wrong.body.result).toBe("wrong_pin");
    expect(typeof wrong.body.retryToken).toBe("string");

    // The first token was spent on the wrong guess.
    const spent = await request<any>(
      "POST",
      `/v1/transfers/${id}/authorize`,
      { pinToken: confirmed.body.pinToken, pin: PIN },
      auth,
    );
    expect(spent.body.result).toBe("expired");

    const sent = await request<any>(
      "POST",
      `/v1/transfers/${id}/authorize`,
      { pinToken: wrong.body.retryToken, pin: PIN },
      auth,
    );
    expectStatus(sent, 200);
    expect(sent.body.result).toBe("successful");
    const row = await prisma().transaction.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("EXECUTED");
    expect(row.originSurface).toBe("NATIVE");
    expect(row.originChannel).toBe("APP");
    ctx.log(
      "confirm, wrong PIN with a fresh token, spent token expired, right PIN: EXECUTED",
    );

    // --- What the chat saw ------------------------------------------------------
    const chat = await prisma().appMessage.findMany({
      where: { userId: me.userId, direction: "OUTBOUND" },
    });
    expect(
      chat.filter((m) => m.kind === "BUTTONS" || m.kind === "FORM_REQUEST"),
    ).toHaveLength(0);
    expect(chat.some((m) => /1,500/.test(m.body ?? ""))).toBe(true);
    ctx.log("the app chat has the result, and no quote card or PIN form");

    // --- Cancel ------------------------------------------------------------------
    const second = await quote(me.accessToken, key(), 700);
    expectStatus(second, 201);
    const secondId = second.body.transfer.id;
    const cancelled = await request<any>(
      "POST",
      `/v1/transfers/${secondId}/cancel`,
      undefined,
      auth,
    );
    expectStatus(cancelled, 200);
    expect(cancelled.body.status).toBe("cancelled");
    const late = await request<any>(
      "POST",
      `/v1/transfers/${secondId}/confirm`,
      undefined,
      auth,
    );
    expectStatus(late, 409);
    expectStatus(
      await request("POST", `/v1/transfers/${id}/cancel`, undefined, auth),
      409,
    );
    ctx.log("a quote can be cancelled; nothing past the PIN can");
  },
});
