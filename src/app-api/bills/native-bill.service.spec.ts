import { HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { currentChannelContext } from "../../messaging/channel-context";
import { NativeBillService, resolvePurchase } from "./native-bill.service";

const principal = { userId: "me", deviceId: "device-1", sessionId: "s1" };
const user = { id: "me", pinLockedUntil: null };

function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    userId: "me",
    status: "PENDING_CONFIRMATION",
    category: "AIRTIME",
    billerCode: "MTN_AIRTIME",
    productCode: "MTN_AIRTIME_PREPAID",
    telcoLabel: "MTN",
    productLabel: null,
    customerName: null,
    msisdn: "08000000000",
    amount: new Prisma.Decimal(500),
    feeAmount: new Prisma.Decimal(0),
    type: "NORMAL",
    vendorToken: null,
    originSurface: "NATIVE",
    createdAt: new Date("2026-10-09T10:00:00Z"),
    confirmedAt: null,
    executedAt: null,
    ...overrides,
  };
}

const airtime = {
  category: "AIRTIME" as const,
  billerCode: "MTN_AIRTIME",
  target: "08000000000",
  amount: 500,
};
const electricity = {
  category: "ELECTRICITY" as const,
  billerCode: "IKEDC",
  target: "45000000000",
  amount: 3000,
};

async function status(p: Promise<unknown> | (() => unknown)): Promise<number> {
  try {
    await (typeof p === "function" ? p() : p);
    return 200;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

async function errorOf(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as HttpException).getResponse();
  }
}

describe("resolvePurchase", () => {
  it("takes airtime's product code and label from the catalog, and normalizes the phone number", () => {
    expect(
      resolvePurchase({ ...airtime, target: "+234 800 000 0000" }),
    ).toEqual({
      category: "AIRTIME",
      billerCode: "MTN_AIRTIME",
      productCode: "MTN_AIRTIME_PREPAID",
      telcoLabel: "MTN",
      msisdn: "08000000000",
      amount: 500,
    });
  });

  it("prices a data bundle from the catalog, and refuses an amount sent with one", async () => {
    expect(
      resolvePurchase({
        category: "DATA",
        billerCode: "MTN_DATA",
        productCode: "MTN_DATA_2GB_30D",
        target: "08000000000",
      }),
    ).toMatchObject({
      productCode: "MTN_DATA_2GB_30D",
      productLabel: "2GB · 30 days",
      telcoLabel: "MTN",
      amount: 1500,
    });
    expect(
      await errorOf(() =>
        resolvePurchase({
          category: "DATA",
          billerCode: "MTN_DATA",
          productCode: "MTN_DATA_2GB_30D",
          target: "08000000000",
          amount: 10,
        }),
      ),
    ).toEqual({ error: "amount_not_allowed" });
  });

  it("takes electricity's product code and label from the catalog", () => {
    expect(resolvePurchase(electricity)).toEqual({
      category: "ELECTRICITY",
      billerCode: "IKEDC",
      productCode: "IKEDC_PREPAID",
      telcoLabel: "Ikeja Electric",
      productLabel: "Prepaid electricity",
      msisdn: "45000000000",
      amount: 3000,
    });
  });

  it.each([
    [
      "an unknown network",
      { ...airtime, billerCode: "NOPE" },
      "unknown_biller",
    ],
    [
      "another product code for airtime",
      { ...airtime, productCode: "GLO_AIRTIME_PREPAID" },
      "unknown_product",
    ],
    [
      "a data bundle not in the catalog",
      {
        category: "DATA" as const,
        billerCode: "MTN_DATA",
        productCode: "MTN_DATA_1TB",
        target: "08000000000",
      },
      "unknown_product",
    ],
    [
      "data with no bundle",
      {
        category: "DATA" as const,
        billerCode: "MTN_DATA",
        target: "08000000000",
      },
      "unknown_product",
    ],
    ["a short phone number", { ...airtime, target: "0800" }, "bad_target"],
    ["a short meter number", { ...electricity, target: "1234" }, "bad_target"],
    ["no amount", { ...airtime, amount: undefined }, "amount_required"],
    [
      "an unknown electricity company",
      { ...electricity, billerCode: "NOPE" },
      "unknown_biller",
    ],
  ])("refuses %s", async (_label, dto, error) => {
    expect(await status(() => resolvePurchase(dto as any))).toBe(400);
    expect(await errorOf(() => resolvePurchase(dto as any))).toMatchObject({
      error,
    });
  });

  it.each([49, 50_001])("refuses ₦%i, outside the bounds", async (amount) => {
    expect(
      await errorOf(() => resolvePurchase({ ...airtime, amount })),
    ).toEqual({ error: "amount_out_of_range", min: 50, max: 50_000 });
  });
});

function build() {
  const contexts: unknown[] = [];
  const prisma = {
    billPayment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(billRow()),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...user,
        rubiesAccountNumber: "0000000009",
      }),
    },
  };
  const bills = {
    createQuote: jest.fn(async () => {
      contexts.push(currentChannelContext());
      return {
        ok: true,
        user,
        payment: billRow(),
        evaluation: { feeAmount: 0, remainingToday: 8_000 },
        balance: 20_000,
      };
    }),
    evaluateConfirm: jest.fn(),
    withdraw: jest.fn().mockResolvedValue(true),
  };
  const pinGate = {
    issueBillPaymentPinToken: jest.fn().mockResolvedValue("pin-tok"),
    issuePinSetupToken: jest.fn().mockResolvedValue("setup-tok"),
    authorizeBillPayment: jest.fn(),
  };
  const pinOutcome = {
    apply: jest.fn(async () => {
      contexts.push(currentChannelContext());
      return { kind: "done" };
    }),
  };
  const allowance = {
    getRemainingSummary: jest.fn().mockResolvedValue({ remainingToday: 6_000 }),
  };
  const rubies = {
    getBalance: jest.fn().mockResolvedValue(30_000),
    validateVasCustomer: jest
      .fn()
      .mockResolvedValue({ ok: true, customerName: "ADA OKAFOR" }),
  };
  const lookups = { claimLookup: jest.fn().mockResolvedValue(undefined) };
  const service = new NativeBillService(
    prisma as any,
    bills as any,
    pinGate as any,
    pinOutcome as any,
    allowance as any,
    rubies as any,
    lookups as any,
  );
  return {
    prisma,
    bills,
    pinGate,
    pinOutcome,
    rubies,
    lookups,
    contexts,
    service,
  };
}

describe("NativeBillService", () => {
  describe("quote", () => {
    it("quotes the resolved purchase on the native surface, in the app's channel, under the app's key", async () => {
      const { service, bills, lookups, contexts } = build();

      const { replayed, view } = await service.quote(
        principal,
        "key-12345678",
        airtime,
      );

      expect(replayed).toBe(false);
      expect(bills.createQuote).toHaveBeenCalledWith({
        userId: "me",
        category: "AIRTIME",
        billerCode: "MTN_AIRTIME",
        productCode: "MTN_AIRTIME_PREPAID",
        telcoLabel: "MTN",
        msisdn: "08000000000",
        amount: 500,
        customerName: undefined,
        surface: "NATIVE",
        clientRequestKey: "key-12345678",
      });
      expect(contexts[0]).toEqual({ channel: "app", deviceId: "device-1" });
      expect(lookups.claimLookup).not.toHaveBeenCalled();
      expect(view).toMatchObject({
        balanceAfter: 19_500,
        allowanceLeftToday: 7_500,
        payment: {
          status: "awaiting_confirmation",
          provider: "MTN",
          surface: "native",
        },
      });
    });

    it("checks the meter with Rubies, spending a lookup, and stores the name Rubies gives", async () => {
      const { service, bills, lookups, rubies } = build();

      await service.quote(principal, "key-12345678", electricity);

      expect(lookups.claimLookup).toHaveBeenCalledWith("me");
      expect(rubies.validateVasCustomer).toHaveBeenCalledWith({
        billerCode: "IKEDC",
        productCode: "IKEDC_PREPAID",
        billerCustomerId: "45000000000",
      });
      expect(lookups.claimLookup.mock.invocationCallOrder[0]).toBeLessThan(
        rubies.validateVasCustomer.mock.invocationCallOrder[0],
      );
      expect(bills.createQuote).toHaveBeenCalledWith(
        expect.objectContaining({ customerName: "ADA OKAFOR" }),
      );
    });

    it("refuses a meter Rubies cannot verify, and quotes nothing", async () => {
      const { service, bills, rubies } = build();
      rubies.validateVasCustomer.mockResolvedValue({ ok: false });

      expect(
        await errorOf(() =>
          service.quote(principal, "key-12345678", electricity),
        ),
      ).toEqual({ error: "meter_unverified" });
      expect(bills.createQuote).not.toHaveBeenCalled();
    });

    it("asks Rubies nothing once the lookup budget is spent", async () => {
      const { service, lookups, rubies, bills } = build();
      lookups.claimLookup.mockRejectedValue(
        new HttpException({ error: "too_many_lookups" }, 429),
      );

      expect(
        await status(service.quote(principal, "key-12345678", electricity)),
      ).toBe(429);
      expect(rubies.validateVasCustomer).not.toHaveBeenCalled();
      expect(bills.createQuote).not.toHaveBeenCalled();
    });

    it("refuses a user with no account before spending a lookup", async () => {
      const { service, prisma, lookups } = build();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...user,
        rubiesAccountNumber: null,
      });
      expect(
        await status(service.quote(principal, "key-12345678", electricity)),
      ).toBe(409);
      expect(lookups.claimLookup).not.toHaveBeenCalled();
    });

    it("returns the same purchase for a replayed key, and creates and looks up nothing", async () => {
      const { service, bills, lookups, prisma } = build();
      prisma.billPayment.findUnique.mockResolvedValue(
        billRow({
          category: "ELECTRICITY",
          billerCode: "IKEDC",
          productCode: "IKEDC_PREPAID",
          msisdn: "45000000000",
          amount: new Prisma.Decimal(3000),
        }),
      );

      const { replayed, view } = await service.quote(
        principal,
        "key-12345678",
        electricity,
      );

      expect(replayed).toBe(true);
      expect(view.payment.id).toBe("bill-1");
      expect(bills.createQuote).not.toHaveBeenCalled();
      expect(lookups.claimLookup).not.toHaveBeenCalled();
    });

    it.each([
      ["amount", { ...airtime, amount: 600 }],
      ["phone number", { ...airtime, target: "08000000001" }],
      ["network", { ...airtime, billerCode: "GLO_AIRTIME" }],
    ])("refuses the same key for a different %s", async (_label, other) => {
      const { service, bills, prisma } = build();
      prisma.billPayment.findUnique.mockResolvedValue(billRow());

      expect(
        await errorOf(() => service.quote(principal, "key-12345678", other)),
      ).toEqual({ error: "idempotency_key_reused" });
      expect(bills.createQuote).not.toHaveBeenCalled();
    });

    it("answers the loser of a same-key race as a replay", async () => {
      const { service, bills, prisma } = build();
      prisma.billPayment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(billRow());
      bills.createQuote.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "5",
        }),
      );

      const { replayed } = await service.quote(
        principal,
        "key-12345678",
        airtime,
      );
      expect(replayed).toBe(true);
    });
  });

  describe("confirm", () => {
    it("asks only the native surface, and returns a PIN token bound to the purchase", async () => {
      const { service, bills, pinGate } = build();
      bills.evaluateConfirm.mockResolvedValue({
        kind: "pin_required",
        payment: { ...billRow(), user },
      });

      const view = await service.confirm(principal, "bill-1");

      expect(bills.evaluateConfirm).toHaveBeenCalledWith(
        "me",
        "bill-1",
        "NATIVE",
      );
      expect(pinGate.issueBillPaymentPinToken).toHaveBeenCalledWith(
        user,
        "bill-1",
      );
      expect(view).toMatchObject({
        decision: "pin_required",
        pinToken: "pin-tok",
      });
    });

    it("re-issues a PIN token when asked again while the PIN is awaited", async () => {
      const { service, bills } = build();
      bills.evaluateConfirm.mockResolvedValue({
        kind: "not_pending",
        payment: { ...billRow({ status: "PENDING_PIN" }), user },
      });
      await expect(service.confirm(principal, "bill-1")).resolves.toMatchObject(
        {
          decision: "pin_required",
          pinToken: "pin-tok",
        },
      );
    });

    it.each([
      ["not_found", 404],
      ["balance_unavailable", 503],
    ])("maps %s to %i", async (kind, code) => {
      const { service, bills } = build();
      bills.evaluateConfirm.mockResolvedValue({
        kind,
        payment: { ...billRow(), user },
      });
      expect(await status(service.confirm(principal, "bill-1"))).toBe(code);
    });

    it("refuses a confirm on a purchase that has moved on", async () => {
      const { service, bills, prisma } = build();
      bills.evaluateConfirm.mockResolvedValue({
        kind: "not_pending",
        payment: { ...billRow({ status: "EXECUTED" }), user },
      });
      prisma.billPayment.findFirst.mockResolvedValue(
        billRow({ status: "EXECUTED" }),
      );
      expect(await status(service.confirm(principal, "bill-1"))).toBe(409);
    });

    it("returns the new terms on a re-quote", async () => {
      const { service, bills } = build();
      bills.evaluateConfirm.mockResolvedValue({
        kind: "requoted",
        reason: "stale",
        payment: { ...billRow(), user },
        evaluation: { feeAmount: 50, remainingToday: 2_000 },
        balance: 1_000,
      });
      await expect(service.confirm(principal, "bill-1")).resolves.toMatchObject(
        {
          requote: {
            reason: "stale",
            balanceAfter: 450,
            allowanceLeftToday: 1_500,
          },
        },
      );
    });
  });

  describe("authorize", () => {
    const pin = { pinToken: "pin-tok", pin: "1234" };

    it("is a 404 for a purchase that is not the caller's native one", async () => {
      const { service, prisma, pinGate } = build();
      prisma.billPayment.findFirst.mockResolvedValue(null);

      expect(await status(service.authorize(principal, "bill-1", pin))).toBe(
        404,
      );
      expect(prisma.billPayment.findFirst).toHaveBeenCalledWith({
        where: { id: "bill-1", userId: "me", originSurface: "NATIVE" },
      });
      expect(pinGate.authorizeBillPayment).not.toHaveBeenCalled();
    });

    it("does not spend a PIN attempt on a purchase not waiting for one", async () => {
      const { service, prisma, pinGate } = build();
      prisma.billPayment.findFirst.mockResolvedValue(
        billRow({ status: "CANCELLED" }),
      );
      expect(await status(service.authorize(principal, "bill-1", pin))).toBe(
        409,
      );
      expect(pinGate.authorizeBillPayment).not.toHaveBeenCalled();
    });

    it("buys through PinOutcomeService, quietly, in the app's channel, and hands back the token", async () => {
      const { service, prisma, pinGate, pinOutcome, contexts } = build();
      prisma.billPayment.findFirst
        .mockResolvedValueOnce(billRow({ status: "PENDING_PIN" }))
        .mockResolvedValue(
          billRow({
            status: "EXECUTED",
            category: "ELECTRICITY",
            vendorToken: "1111-2222",
            executedAt: new Date(),
          }),
        );
      const outcome = {
        action: "execute_bill_payment",
        billPaymentId: "bill-1",
      };
      pinGate.authorizeBillPayment.mockResolvedValue({
        kind: "verified",
        outcome,
      });

      const view = await service.authorize(principal, "bill-1", pin);

      expect(pinGate.authorizeBillPayment).toHaveBeenCalledWith(
        expect.objectContaining({ id: "me" }),
        "pin-tok",
        "bill-1",
        "1234",
      );
      expect(pinOutcome.apply).toHaveBeenCalledWith(outcome, "me", {
        quiet: true,
      });
      expect(contexts[0]).toEqual({ channel: "app", deviceId: "device-1" });
      expect(view.result).toBe("successful");
      expect(view.payment.token).toBe("1111-2222");
    });

    it("reports the new-phone limit with its figures", async () => {
      const { service, prisma, pinGate, pinOutcome } = build();
      prisma.billPayment.findFirst
        .mockResolvedValueOnce(billRow({ status: "PENDING_PIN" }))
        .mockResolvedValue(billRow({ status: "CANCELLED" }));
      pinGate.authorizeBillPayment.mockResolvedValue({
        kind: "verified",
        outcome: { action: "execute_bill_payment", billPaymentId: "bill-1" },
      });
      const liftsAt = new Date("2026-10-10T09:00:00Z");
      pinOutcome.apply.mockResolvedValue({
        kind: "capped",
        cap: 20_000,
        remaining: 100,
        liftsAt,
      } as any);

      await expect(
        service.authorize(principal, "bill-1", pin),
      ).resolves.toMatchObject({
        result: "cap_exceeded",
        cap: { cap: 20_000, remaining: 100, liftsAt: liftsAt.toISOString() },
      });
    });

    it("passes a wrong PIN's reason and fresh token through, and buys nothing", async () => {
      const { service, prisma, pinGate, pinOutcome } = build();
      prisma.billPayment.findFirst.mockResolvedValue(
        billRow({ status: "PENDING_PIN" }),
      );
      pinGate.authorizeBillPayment.mockResolvedValue({
        kind: "wrong_pin",
        message: "that pin isn't right.",
        retryToken: "tok-2",
      });

      await expect(
        service.authorize(principal, "bill-1", pin),
      ).resolves.toMatchObject({ result: "wrong_pin", retryToken: "tok-2" });
      expect(pinOutcome.apply).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("cancels the caller's native purchase", async () => {
      const { service, bills, prisma } = build();
      prisma.billPayment.findFirst.mockResolvedValue(
        billRow({ status: "CANCELLED" }),
      );
      const view = await service.cancel(principal, "bill-1");
      expect(bills.withdraw).toHaveBeenCalledWith("me", "bill-1");
      expect(view.status).toBe("cancelled");
    });

    it("is a 409 past the PIN and a 404 for anyone else's", async () => {
      const { service, bills, prisma } = build();
      bills.withdraw.mockResolvedValue(false);
      prisma.billPayment.findFirst.mockResolvedValueOnce(
        billRow({ status: "CONFIRMED" }),
      );
      expect(await status(service.cancel(principal, "bill-1"))).toBe(409);
      prisma.billPayment.findFirst.mockResolvedValueOnce(null);
      expect(await status(service.cancel(principal, "bill-1"))).toBe(404);
    });
  });

  it("shows an electricity token only once the purchase has gone through", async () => {
    const { service, prisma } = build();
    prisma.billPayment.findFirst.mockResolvedValueOnce(
      billRow({ status: "CONFIRMED", vendorToken: "1111-2222" }),
    );
    expect((await service.get(principal, "bill-1")).token).toBeNull();
  });
});
