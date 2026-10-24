import { HttpException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { currentChannelContext } from "../../messaging/channel-context";
import { NativeTransferService } from "./native-transfer.service";

const principal = { userId: "me", deviceId: "device-1", sessionId: "s1" };
const user = { id: "me", pinLockedUntil: null };
const recipient = {
  accountName: "ADA OKAFOR",
  nickname: null,
  accountNumber: "0000000001",
  bankCode: "000005",
};

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn-1",
    userId: "me",
    status: "PENDING_CONFIRMATION",
    amount: new Prisma.Decimal(5000),
    feeAmount: new Prisma.Decimal(0),
    type: "NORMAL",
    purposeLabel: "FOOD",
    originSurface: "NATIVE",
    createdAt: new Date("2026-09-26T10:00:00Z"),
    confirmedAt: null,
    executedAt: null,
    recipient,
    ...overrides,
  };
}

const dto = {
  accountNumber: "0000000001",
  bankCode: "000005",
  amount: 5000,
  purpose: "FOOD" as const,
};

function build() {
  const prisma = {
    transaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(txRow()),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        ...user,
        rubiesAccountNumber: "0000000009",
      }),
    },
  };
  const transfers = {
    createQuote: jest.fn(async () => {
      contexts.push(currentChannelContext());
      return {
        ok: true,
        user,
        transaction: txRow(),
        recipient,
        isNewRecipient: true,
        evaluation: { feeAmount: 0, remainingToday: 8_000 },
        balance: 20_000,
      };
    }),
    evaluateConfirm: jest.fn(),
    withdraw: jest.fn().mockResolvedValue(true),
  };
  const contexts: unknown[] = [];
  const pinGate = {
    issueTransferPinToken: jest.fn().mockResolvedValue("pin-tok"),
    issuePinSetupToken: jest.fn().mockResolvedValue("setup-tok"),
    authorizeTransfer: jest.fn(),
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
  const rubies = { getBalance: jest.fn().mockResolvedValue(30_000) };
  const banks = {
    names: jest.fn().mockResolvedValue(new Map([["000005", "Access Bank"]])),
  };
  // A recipient not yet saved, by default: the quote will look them up.
  const tagging = { findRecipient: jest.fn().mockResolvedValue(null) };
  const lookups = { claimLookup: jest.fn().mockResolvedValue(undefined) };
  const service = new NativeTransferService(
    prisma as any,
    transfers as any,
    pinGate as any,
    pinOutcome as any,
    allowance as any,
    rubies as any,
    banks as any,
    tagging as any,
    lookups as any,
  );
  return {
    prisma,
    transfers,
    pinGate,
    pinOutcome,
    tagging,
    lookups,
    contexts,
    service,
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

describe("NativeTransferService", () => {
  describe("quote", () => {
    it("quotes on the native surface, in the app's channel, under the app's key", async () => {
      const { service, transfers, contexts } = build();

      const { replayed, view } = await service.quote(
        principal,
        "key-12345678",
        dto,
      );

      expect(replayed).toBe(false);
      expect(transfers.createQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "me",
          surface: "NATIVE",
          clientRequestKey: "key-12345678",
          purposeLabel: "FOOD",
        }),
      );
      expect(contexts[0]).toEqual({ channel: "app", deviceId: "device-1" });
      expect(view).toMatchObject({
        isNewRecipient: true,
        balanceAfter: 15_000,
        allowanceLeftToday: 3_000,
        transfer: {
          status: "awaiting_confirmation",
          surface: "native",
          recipient: { bankName: "Access Bank" },
        },
      });
    });

    it("returns the same transfer for a replayed key, and creates nothing", async () => {
      const { service, transfers, prisma } = build();
      prisma.transaction.findUnique.mockResolvedValue(txRow());

      const { replayed, view } = await service.quote(
        principal,
        "key-12345678",
        dto,
      );

      expect(replayed).toBe(true);
      expect(view.transfer.id).toBe("txn-1");
      expect(view.balanceAfter).toBe(25_000);
      expect(transfers.createQuote).not.toHaveBeenCalled();
      expect(prisma.transaction.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_clientRequestKey: {
              userId: "me",
              clientRequestKey: "key-12345678",
            },
          },
        }),
      );
    });

    it.each([
      ["amount", { ...dto, amount: 5001 }],
      ["account", { ...dto, accountNumber: "0000000002" }],
      ["bank", { ...dto, bankCode: "000004" }],
    ])("refuses the same key for a different %s", async (_label, other) => {
      const { service, transfers, prisma } = build();
      prisma.transaction.findUnique.mockResolvedValue(txRow());

      expect(
        await status(service.quote(principal, "key-12345678", other)),
      ).toBe(422);
      expect(transfers.createQuote).not.toHaveBeenCalled();
    });

    it("answers the loser of a same-key race as a replay", async () => {
      const { service, transfers, prisma } = build();
      prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(txRow());
      transfers.createQuote.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "5",
        }),
      );

      const { replayed } = await service.quote(principal, "key-12345678", dto);
      expect(replayed).toBe(true);
    });

    /**
     * A quote to a new recipient returns the name the bank holds, which is
     * what POST /v1/name-enquiry does; it spends from the same budget.
     */
    it("spends a lookup from the hourly budget for a recipient not yet saved", async () => {
      const { service, lookups, tagging, transfers } = build();

      await service.quote(principal, "key-12345678", dto);

      expect(tagging.findRecipient).toHaveBeenCalledWith(
        "me",
        "0000000001",
        "000005",
      );
      expect(lookups.claimLookup).toHaveBeenCalledWith("me");
      expect(lookups.claimLookup.mock.invocationCallOrder[0]).toBeLessThan(
        transfers.createQuote.mock.invocationCallOrder[0],
      );
    });

    it("spends nothing for a saved recipient, or on a replay", async () => {
      const saved = build();
      saved.tagging.findRecipient.mockResolvedValue({ id: "r1" });
      await saved.service.quote(principal, "key-12345678", dto);
      expect(saved.lookups.claimLookup).not.toHaveBeenCalled();

      const replay = build();
      replay.prisma.transaction.findUnique.mockResolvedValue(txRow());
      await replay.service.quote(principal, "key-12345678", dto);
      expect(replay.lookups.claimLookup).not.toHaveBeenCalled();
    });

    it("quotes nothing once the lookup budget is spent", async () => {
      const { service, lookups, transfers } = build();
      lookups.claimLookup.mockRejectedValue(
        new HttpException({ error: "too_many_lookups" }, 429),
      );

      expect(await status(service.quote(principal, "key-12345678", dto))).toBe(
        429,
      );
      expect(transfers.createQuote).not.toHaveBeenCalled();
    });

    it("refuses a user with no account before spending a lookup", async () => {
      const { service, prisma, lookups, transfers } = build();
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...user,
        rubiesAccountNumber: null,
      });

      expect(await status(service.quote(principal, "key-12345678", dto))).toBe(
        409,
      );
      expect(lookups.claimLookup).not.toHaveBeenCalled();
      expect(transfers.createQuote).not.toHaveBeenCalled();
    });

    it("maps no account to 409 and an unverifiable recipient to 422", async () => {
      const { service, transfers } = build();
      transfers.createQuote.mockResolvedValueOnce({
        ok: false,
        reason: "no_account",
        user,
      } as any);
      expect(await status(service.quote(principal, "key-12345678", dto))).toBe(
        409,
      );
      transfers.createQuote.mockResolvedValueOnce({
        ok: false,
        reason: "recipient_unverified",
        user,
      } as any);
      expect(await status(service.quote(principal, "key-12345678", dto))).toBe(
        422,
      );
    });
  });

  describe("confirm", () => {
    it("asks only the native surface, and returns a PIN token when the PIN is next", async () => {
      const { service, transfers, pinGate } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind: "pin_required",
        transaction: { ...txRow(), user },
      });

      const view = await service.confirm(principal, "txn-1");

      expect(transfers.evaluateConfirm).toHaveBeenCalledWith(
        "me",
        "txn-1",
        "NATIVE",
      );
      expect(pinGate.issueTransferPinToken).toHaveBeenCalledWith(user, "txn-1");
      expect(view).toMatchObject({
        decision: "pin_required",
        pinToken: "pin-tok",
      });
    });

    it("re-issues a PIN token when asked again while the PIN is awaited", async () => {
      const { service, transfers } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind: "not_pending",
        transaction: { ...txRow({ status: "PENDING_PIN" }), user },
      });

      const view = await service.confirm(principal, "txn-1");

      expect(view).toMatchObject({
        decision: "pin_required",
        pinToken: "pin-tok",
      });
    });

    it("refuses a confirm on a transfer that has moved on", async () => {
      const { service, transfers, prisma } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind: "not_pending",
        transaction: { ...txRow({ status: "EXECUTED" }), user },
      });
      prisma.transaction.findFirst.mockResolvedValue(
        txRow({ status: "EXECUTED" }),
      );
      expect(await status(service.confirm(principal, "txn-1"))).toBe(409);
    });

    it.each([
      ["not_found", 404],
      ["balance_unavailable", 503],
    ])("maps %s to %i", async (kind, code) => {
      const { service, transfers } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind,
        transaction: { ...txRow(), user },
      });
      expect(await status(service.confirm(principal, "txn-1"))).toBe(code);
    });

    it("returns the new terms on a re-quote", async () => {
      const { service, transfers } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind: "requoted",
        reason: "terms_changed",
        transaction: { ...txRow(), user },
        evaluation: { feeAmount: 250, remainingToday: 7_000 },
        balance: 10_000,
      });

      const view = await service.confirm(principal, "txn-1");

      expect(view.requote).toEqual({
        reason: "terms_changed",
        balanceAfter: 4_750,
        allowanceLeftToday: 2_000,
      });
    });

    it("hands over a setup token when there is no PIN yet", async () => {
      const { service, transfers } = build();
      transfers.evaluateConfirm.mockResolvedValue({
        kind: "pin_setup_required",
        transaction: { ...txRow(), user },
      });
      await expect(service.confirm(principal, "txn-1")).resolves.toMatchObject({
        decision: "pin_setup_required",
        setupToken: "setup-tok",
      });
    });
  });

  describe("authorize", () => {
    const pin = { pinToken: "pin-tok", pin: "1234" };

    it("is a 404 for a transfer that is not the caller's native one", async () => {
      const { service, prisma, pinGate } = build();
      prisma.transaction.findFirst.mockResolvedValue(null);

      expect(await status(service.authorize(principal, "txn-1", pin))).toBe(
        404,
      );
      expect(prisma.transaction.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "txn-1", userId: "me", originSurface: "NATIVE" },
        }),
      );
      expect(pinGate.authorizeTransfer).not.toHaveBeenCalled();
    });

    it("does not spend a PIN attempt on a transfer not waiting for one", async () => {
      const { service, prisma, pinGate } = build();
      prisma.transaction.findFirst.mockResolvedValue(
        txRow({ status: "CANCELLED" }),
      );

      expect(await status(service.authorize(principal, "txn-1", pin))).toBe(
        409,
      );
      expect(pinGate.authorizeTransfer).not.toHaveBeenCalled();
    });

    it("executes through PinOutcomeService, quietly, in the app's channel, and reports the result", async () => {
      const { service, prisma, pinGate, pinOutcome, contexts } = build();
      prisma.transaction.findFirst
        .mockResolvedValueOnce(txRow({ status: "PENDING_PIN" }))
        .mockResolvedValue(
          txRow({ status: "EXECUTED", executedAt: new Date() }),
        );
      const outcome = { action: "execute_transfer", transactionId: "txn-1" };
      pinGate.authorizeTransfer.mockResolvedValue({
        kind: "verified",
        outcome,
      });

      const view = await service.authorize(principal, "txn-1", pin);

      expect(pinGate.authorizeTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ id: "me" }),
        "pin-tok",
        "txn-1",
        "1234",
      );
      expect(pinOutcome.apply).toHaveBeenCalledWith(outcome, "me", {
        quiet: true,
      });
      expect(contexts[0]).toEqual({ channel: "app", deviceId: "device-1" });
      expect(view.result).toBe("successful");
    });

    it.each([
      ["CONFIRMED", "processing"],
      ["FAILED", "failed"],
      ["CANCELLED", "expired"],
    ])("reports a transfer left %s as %s", async (after, result) => {
      const { service, prisma, pinGate } = build();
      prisma.transaction.findFirst
        .mockResolvedValueOnce(txRow({ status: "PENDING_PIN" }))
        .mockResolvedValue(txRow({ status: after }));
      pinGate.authorizeTransfer.mockResolvedValue({
        kind: "verified",
        outcome: { action: "execute_transfer", transactionId: "txn-1" },
      });
      await expect(
        service.authorize(principal, "txn-1", pin),
      ).resolves.toMatchObject({
        result,
      });
    });

    it("reports the new-phone limit with its figures", async () => {
      const { service, prisma, pinGate, pinOutcome } = build();
      prisma.transaction.findFirst
        .mockResolvedValueOnce(txRow({ status: "PENDING_PIN" }))
        .mockResolvedValue(txRow({ status: "CANCELLED" }));
      pinGate.authorizeTransfer.mockResolvedValue({
        kind: "verified",
        outcome: { action: "execute_transfer", transactionId: "txn-1" },
      });
      const liftsAt = new Date("2026-09-27T09:00:00Z");
      pinOutcome.apply.mockResolvedValue({
        kind: "capped",
        cap: 20_000,
        remaining: 1_000,
        liftsAt,
      } as any);

      await expect(
        service.authorize(principal, "txn-1", pin),
      ).resolves.toMatchObject({
        result: "cap_exceeded",
        cap: { cap: 20_000, remaining: 1_000, liftsAt: liftsAt.toISOString() },
      });
    });

    it("passes a wrong PIN's reason and fresh token through, and executes nothing", async () => {
      const { service, prisma, pinGate, pinOutcome } = build();
      prisma.transaction.findFirst.mockResolvedValue(
        txRow({ status: "PENDING_PIN" }),
      );
      pinGate.authorizeTransfer.mockResolvedValue({
        kind: "wrong_pin",
        message: "that pin isn't right.",
        retryToken: "tok-2",
      });

      await expect(
        service.authorize(principal, "txn-1", pin),
      ).resolves.toMatchObject({
        result: "wrong_pin",
        message: "that pin isn't right.",
        retryToken: "tok-2",
      });
      expect(pinOutcome.apply).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("cancels the caller's native transfer", async () => {
      const { service, transfers, prisma } = build();
      prisma.transaction.findFirst.mockResolvedValue(
        txRow({ status: "CANCELLED" }),
      );

      const view = await service.cancel(principal, "txn-1");

      expect(transfers.withdraw).toHaveBeenCalledWith("me", "txn-1");
      expect(view.status).toBe("cancelled");
    });

    it("is a 409 past the PIN and a 404 for anyone else's", async () => {
      const { service, transfers, prisma } = build();
      transfers.withdraw.mockResolvedValue(false);
      prisma.transaction.findFirst.mockResolvedValueOnce(
        txRow({ status: "CONFIRMED" }),
      );
      expect(await status(service.cancel(principal, "txn-1"))).toBe(409);
      prisma.transaction.findFirst.mockResolvedValueOnce(null);
      expect(await status(service.cancel(principal, "txn-1"))).toBe(404);
    });
  });

  it("shows the fee note the WhatsApp card shows, including a waived one", async () => {
    const { service, prisma } = build();
    prisma.transaction.findFirst.mockResolvedValueOnce(
      txRow({ type: "EARLY_ACCESS", feeAmount: new Prisma.Decimal(1020) }),
    );
    expect((await service.get(principal, "txn-1")).feeNote).toBe(
      "outside spending window fee: ₦1,020",
    );
    prisma.transaction.findFirst.mockResolvedValueOnce(
      txRow({ type: "EARLY_ACCESS", feeAmount: new Prisma.Decimal(0) }),
    );
    expect((await service.get(principal, "txn-1")).feeNote).toBe(
      "outside spending window (fee waived)",
    );
  });
});
