import { createHmac } from "crypto";
import { OnboardingStage, Prisma } from "@prisma/client";
import { defineScenario } from "../../runner/define";
import { request } from "../../helpers/http";
import { expect, expectStatus } from "../../helpers/assert";
import {
  bearer,
  requestCode,
  setPinDirectly,
  signInNewNumber,
  uniqueNigerianMobile,
  verifyCode,
} from "../../helpers/app";
import { prisma } from "../../helpers/db";
import { runOpsCli } from "../../helpers/ops";

const PIN = "7351";
const DAY = 24 * 60 * 60 * 1000;

/** Lets the same number ask for another sign-in code straight away. */
async function allowAnotherCode(phoneNumber: string) {
  await prisma().authOtp.updateMany({
    where: { phoneNumber },
    data: { createdAt: new Date(Date.now() - 2 * 60_000) },
  });
}

/** An email-check code the runner knows, in EmailVerificationService's format. */
async function plantEmailCode(userId: string, email: string, code: string) {
  const pepper = (process.env.OTP_PEPPER ?? "").trim();
  if (!pepper) throw new Error("set OTP_PEPPER for the e2e runner");
  await prisma().emailVerification.create({
    data: {
      userId,
      email,
      codeHmac: createHmac("sha256", pepper)
        .update(`email:${userId}:${email}:${code}`, "utf8")
        .digest("hex"),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
}

function closeWithCli(requestId: string, ...flags: string[]) {
  return runOpsCli("account-closure-cli.ts", [
    "close",
    "--id",
    requestId,
    ...flags,
  ]);
}

export default defineScenario({
  name: "app.account.compliance",
  description:
    "Devices listed and signed out; settings requests filed and withdrawn; email checked with a code; terms re-consent; a closure asked for, refused with money in the account, withdrawn; then the ops CLI closes a never-opened account and an account holder, keeping and erasing exactly what ADR-0003 says",
  tags: ["app", "security", "compliance"],
  async run(ctx) {
    // --- Devices ---------------------------------------------------------------
    const me = await signInNewNumber();
    const auth = bearer(me.accessToken);
    await allowAnotherCode(me.phoneNumber);
    const second = await signInNewNumber(me.phoneNumber);
    expect(second.userId).toBe(me.userId);

    const listed = await request<any>("GET", "/v1/devices", undefined, auth);
    expectStatus(listed, 200);
    expect(listed.body.devices).toHaveLength(2);
    expect(listed.body.devices.filter((d: any) => d.current)).toHaveLength(1);
    const otherPhone = listed.body.devices.find((d: any) => !d.current);

    const stranger = await signInNewNumber();
    const theirs = bearer(stranger.accessToken);
    expectStatus(
      await request(
        "DELETE",
        `/v1/devices/${otherPhone.id}`,
        undefined,
        theirs,
      ),
      404,
    );
    expectStatus(
      await request("GET", "/v1/me", undefined, bearer(second.accessToken)),
      200,
    );
    expectStatus(
      await request("DELETE", `/v1/devices/${otherPhone.id}`, undefined, auth),
      204,
    );
    expectStatus(
      await request("GET", "/v1/me", undefined, bearer(second.accessToken)),
      401,
    );
    expectStatus(
      await request("DELETE", "/v1/devices/push-token", undefined, auth),
      204,
    );
    const after = await request<any>("GET", "/v1/devices", undefined, auth);
    expect(after.body.devices).toHaveLength(1);
    ctx.log(
      "devices: listed, a stranger gets 404, the other phone signed out at once",
    );

    // --- Settings requests -----------------------------------------------------------
    const filed = await request<any>(
      "POST",
      "/v1/settings-requests",
      { type: "window_hours", requestedChange: "open my window at 9am" },
      auth,
    );
    expectStatus(filed, 201);
    expect(filed.body).toMatchObject({
      type: "window_hours",
      status: "pending",
    });
    expect(
      new Date(filed.body.eligibleAt).getTime() -
        new Date(filed.body.requestedAt).getTime(),
    ).toBeGreaterThanOrEqual(7 * DAY - 1000);
    const again = await request<any>(
      "POST",
      "/v1/settings-requests",
      { type: "window_hours", requestedChange: "please" },
      auth,
    );
    expectStatus(again, 409);
    expect(again.body.error).toBe("request_open");
    expectStatus(
      await request(
        "POST",
        "/v1/settings-requests",
        { type: "account_deletion", requestedChange: "close it" },
        auth,
      ),
      400,
    );
    expectStatus(
      await request(
        "POST",
        `/v1/settings-requests/${filed.body.id}/withdraw`,
        undefined,
        theirs,
      ),
      404,
    );
    const withdrawn = await request<any>(
      "POST",
      `/v1/settings-requests/${filed.body.id}/withdraw`,
      undefined,
      auth,
    );
    expectStatus(withdrawn, 200);
    expect(withdrawn.body.status).toBe("withdrawn");
    expectStatus(
      await request(
        "POST",
        `/v1/settings-requests/${filed.body.id}/withdraw`,
        undefined,
        auth,
      ),
      409,
    );
    const acknowledged = await prisma().appMessage.findFirst({
      where: {
        userId: me.userId,
        direction: "OUTBOUND",
        body: { contains: "managers have received your request" },
      },
    });
    expect(acknowledged).not.toBeNull();
    ctx.log(
      "settings requests: filed through the managers, one open per kind, withdrawn once",
    );

    // --- Email check -------------------------------------------------------------------
    const email = `e2e-${me.userId.slice(0, 8)}@example.com`;
    await prisma().user.update({ where: { id: me.userId }, data: { email } });
    // The server runs without a Resend key, so the honest answer is that no
    // email went, and the code it made is dead.
    const start = await request<any>(
      "POST",
      "/v1/email/verify/start",
      undefined,
      auth,
    );
    expectStatus(start, 503);
    expect(start.body.error).toBe("email_unavailable");
    expect(
      await prisma().emailVerification.count({
        where: { userId: me.userId, consumedAt: null },
      }),
    ).toBe(0);
    await plantEmailCode(me.userId, email, "482913");
    const wrong = await request<any>(
      "POST",
      "/v1/email/verify/confirm",
      { code: "000000" },
      auth,
    );
    expectStatus(wrong, 422);
    expect(wrong.body).toMatchObject({
      error: "invalid_code",
      attemptsLeft: 4,
    });
    expectStatus(
      await request(
        "POST",
        "/v1/email/verify/confirm",
        { code: "482913" },
        auth,
      ),
      200,
    );
    const meNow = await request<any>("GET", "/v1/me", undefined, auth);
    expect(meNow.body.emailVerified).toBe(true);
    ctx.log(
      "email: no Resend key gives 503, a planted code verifies, a wrong one counts down",
    );

    // --- Terms ---------------------------------------------------------------------------
    expect(meNow.body.needsTermsConsent).toBe(false);
    const current = await request<any>("GET", "/v1/terms", undefined, auth);
    expectStatus(current, 200);
    const notYet = await request<any>(
      "POST",
      "/v1/terms/accept",
      { version: current.body.version },
      auth,
    );
    expectStatus(notYet, 409);
    expect(notYet.body.error).toBe("not_onboarded");
    await prisma().user.update({
      where: { id: me.userId },
      data: {
        termsAcceptedAt: new Date(Date.now() - 30 * DAY),
        termsVersion: "2025-01-v0",
      },
    });
    expect(
      (await request<any>("GET", "/v1/me", undefined, auth)).body
        .needsTermsConsent,
    ).toBe(true);
    expectStatus(
      await request(
        "POST",
        "/v1/terms/accept",
        { version: "2025-01-v0" },
        auth,
      ),
      409,
    );
    expectStatus(
      await request(
        "POST",
        "/v1/terms/accept",
        { version: current.body.version },
        auth,
      ),
      200,
    );
    expect(
      (await request<any>("GET", "/v1/me", undefined, auth)).body
        .needsTermsConsent,
    ).toBe(false);
    ctx.log(
      "terms: re-consent asked only after an older version, and recorded",
    );

    // --- Asking to close: someone with no bank account ----------------------------------------
    const status = await request<any>(
      "GET",
      "/v1/account/deletion",
      undefined,
      auth,
    );
    expectStatus(status, 200);
    expect(status.body).toMatchObject({
      canRequest: true,
      blockers: [],
      hasAccount: false,
      pinRequired: false,
      notice:
        "we'll close your udara account and delete everything we hold about you.",
    });
    const firstAsk = await request<any>(
      "POST",
      "/v1/account/deletion",
      {},
      auth,
    );
    expectStatus(firstAsk, 201);
    expect(firstAsk.body.request).toMatchObject({
      type: "account_deletion",
      status: "pending",
    });
    expectStatus(await request("POST", "/v1/account/deletion", {}, auth), 409);
    const told = await prisma().appMessage.findFirst({
      where: {
        userId: me.userId,
        body: { contains: "your request to close your udara account is in" },
      },
    });
    expect(told).not.toBeNull();
    expectStatus(
      await request(
        "POST",
        `/v1/settings-requests/${firstAsk.body.request.id}/withdraw`,
        undefined,
        auth,
      ),
      200,
    );
    const ask = await request<any>(
      "POST",
      "/v1/account/deletion",
      { reason: "e2e" },
      auth,
    );
    expectStatus(ask, 201);
    ctx.log("closure asked for, confirmed in the chat, withdrawn, asked again");

    // --- Asking to close: an account holder with money ------------------------------------------
    const holder = await signInNewNumber(uniqueNigerianMobile());
    const holderAuth = bearer(holder.accessToken);
    await prisma().user.update({
      where: { id: holder.userId },
      data: {
        rubiesAccountId: `cust-${holder.phoneNumber.slice(-8)}`,
        rubiesAccountNumber: `44${holder.phoneNumber.slice(-8)}`,
        rubiesAccountName: "E2E HOLDER",
        legalFirstName: "Eko",
        legalLastName: "Holder",
        name: "Eko",
        statedGoal: "stop impulse buys",
        onboardingStage: OnboardingStage.COMPLETE,
        flatDailyAmount: new Prisma.Decimal(5000),
      },
    });
    await setPinDirectly(holder.userId, PIN);
    const holderStatus = await request<any>(
      "GET",
      "/v1/account/deletion",
      undefined,
      holderAuth,
    );
    expect(holderStatus.body).toMatchObject({
      canRequest: false,
      blockers: ["balance_not_zero"],
      balance: 10_000_000,
      hasAccount: true,
      pinRequired: true,
    });
    const refused = await request<any>(
      "POST",
      "/v1/account/deletion",
      { pin: PIN },
      holderAuth,
    );
    expectStatus(refused, 409);
    expect(refused.body).toMatchObject({
      error: "balance_not_zero",
      balance: 10_000_000,
    });
    ctx.log(
      "an account holder with money is refused, with the balance, before the PIN",
    );

    // --- The ops CLI closes someone who never opened an account ----------------------------------
    await prisma().settingsChangeRequest.update({
      where: { id: ask.body.request.id },
      data: { eligibleAt: new Date(Date.now() - 60_000) },
    });
    const dryRun = await closeWithCli(ask.body.request.id);
    expect(dryRun.status).toBe(0);
    expect(dryRun.output).toContain("Dry run");
    expect(
      (await prisma().user.findUniqueOrThrow({ where: { id: me.userId } }))
        .closedAt,
    ).toBeNull();

    const closed = await closeWithCli(
      ask.body.request.id,
      "--confirm",
      "--notes",
      "e2e",
    );
    if (closed.status !== 0)
      throw new Error(`account:close failed:\n${closed.output}`);
    const gone = await prisma().user.findUniqueOrThrow({
      where: { id: me.userId },
    });
    expect(gone).toMatchObject({
      phoneNumber: `closed:${me.userId}`,
      closedPhoneNumber: null,
      whatsappNumber: null,
      email: null,
      emailVerifiedAt: null,
      termsAcceptedAt: null,
      pinHash: null,
    });
    expect(gone.closedAt).not.toBeNull();
    for (const [table, count] of Object.entries({
      device: await prisma().device.count({ where: { userId: me.userId } }),
      appSession: await prisma().appSession.count({
        where: { userId: me.userId },
      }),
      appMessage: await prisma().appMessage.count({
        where: { userId: me.userId },
      }),
      emailVerification: await prisma().emailVerification.count({
        where: { userId: me.userId },
      }),
      authOtp: await prisma().authOtp.count({
        where: { phoneNumber: me.phoneNumber },
      }),
    })) {
      expect([table, count]).toEqual([table, 0]);
    }
    const requests = await prisma().settingsChangeRequest.findMany({
      where: { userId: me.userId },
    });
    expect(requests.length).toBe(3);
    expect(requests.every((r) => r.reason === null)).toBe(true);
    expect(requests.find((r) => r.id === filed.body.id)?.requestedChange).toBe(
      "(erased when the account was closed)",
    );
    expect(requests.find((r) => r.id === ask.body.request.id)?.status).toBe(
      "APPROVED",
    );
    expectStatus(await request("GET", "/v1/me", undefined, auth), 401);

    // The number is free: it signs up as a brand-new account.
    await requestCode(me.phoneNumber);
    const reborn = await verifyCode(me.phoneNumber);
    expectStatus(reborn, 200);
    expect(reborn.body.user.isNewUser).toBe(true);
    expect(reborn.body.user.id).not.toBe(me.userId);
    ctx.log(
      "CLI: dry run changes nothing; closing erases everything and frees the number",
    );

    // --- The ops CLI closes an account holder ---------------------------------------------------
    const paid = await prisma().recipient.create({
      data: {
        userId: holder.userId,
        accountNumber: "0123456789",
        bankCode: "000013",
        accountName: "PAID PERSON",
        nickname: "landlord",
      },
    });
    await prisma().recipient.create({
      data: {
        userId: holder.userId,
        accountNumber: "9876543210",
        bankCode: "000013",
        accountName: "NEVER PAID",
        nickname: "cousin",
      },
    });
    const transfer = await prisma().transaction.create({
      data: {
        userId: holder.userId,
        recipientId: paid.id,
        amount: new Prisma.Decimal(2500),
        status: "EXECUTED",
        executedAt: new Date(Date.now() - 3 * DAY),
      },
    });
    const holderAsk = await prisma().settingsChangeRequest.create({
      data: {
        userId: holder.userId,
        type: "ACCOUNT_DELETION",
        requestedChange: "close my account",
        requestedAt: new Date(Date.now() - 9 * DAY),
        eligibleAt: new Date(Date.now() - 2 * DAY),
      },
    });

    const withMoney = await closeWithCli(holderAsk.id, "--confirm");
    expect(withMoney.status).toBe(1);
    expect(withMoney.output).toContain("balance_not_zero");

    const holderClosed = await closeWithCli(
      holderAsk.id,
      "--confirm",
      "--residual-handled",
    );
    if (holderClosed.status !== 0) {
      throw new Error(`account:close failed:\n${holderClosed.output}`);
    }
    expect(holderClosed.output).toContain(
      `ask Rubies to close account 44${holder.phoneNumber.slice(-8)}`,
    );
    const kept = await prisma().user.findUniqueOrThrow({
      where: { id: holder.userId },
    });
    expect(kept).toMatchObject({
      phoneNumber: `closed:${holder.userId}`,
      closedPhoneNumber: holder.phoneNumber,
      legalFirstName: "Eko",
      legalLastName: "Holder",
      rubiesAccountNumber: `44${holder.phoneNumber.slice(-8)}`,
      name: null,
      statedGoal: null,
      flatDailyAmount: null,
      pinHash: null,
    });
    expect(
      await prisma().transaction.findUnique({ where: { id: transfer.id } }),
    ).not.toBeNull();
    const recipients = await prisma().recipient.findMany({
      where: { userId: holder.userId },
    });
    expect(recipients).toEqual([
      expect.objectContaining({
        id: paid.id,
        accountName: "PAID PERSON",
        nickname: null,
      }),
    ]);
    const lastWord = await prisma().appMessage.findFirst({
      where: {
        userId: holder.userId,
        body: { contains: "your udara account is closed" },
      },
    });
    expect(lastWord).not.toBeNull();
    expect(
      await prisma().device.count({ where: { userId: holder.userId } }),
    ).toBe(0);
    expectStatus(await request("GET", "/v1/me", undefined, holderAuth), 401);
    ctx.log(
      "CLI: refused with money, closed with --residual-handled; identity, payments, paid recipient and the chat kept; the rest erased",
    );
  },
});
