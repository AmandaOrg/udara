import { Logger } from "@nestjs/common";
import {
  BillPaymentStatus,
  EmailType,
  Prisma,
  RecipientLabel,
  SettingsChangeStatus,
  SettingsChangeType,
  TransactionStatus,
} from "@prisma/client";
import {
  AccountClosureService,
  CLOSURE_REQUEST_TEXT,
  ClosureRefusedError,
  ERASED_REQUEST_TEXT,
  USER_FIELDS,
  USER_TABLES,
} from "./account-closure.service";
import { RETENTION_YEARS_AFTER_CLOSURE } from "./retention-policy";
import {
  RETENTION_PERIOD_WORDS,
  accountClosedText,
  closureDeclinedText,
  closureNotice,
  closureRequestedText,
} from "./closure-copy";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-20T09:00:00Z");

/**
 * ADR-0003 in tests: what closing an account keeps, what it erases, and
 * everything that must stop it. Closure cannot be undone, so the refusals are
 * tested as carefully as the erasure.
 */
describe("ADR-0003 covers the whole schema", () => {
  it("decides every User column exactly once", () => {
    const decided: string[] = Object.values(USER_FIELDS).flat();
    expect(new Set(decided).size).toBe(decided.length);
    expect([...decided].sort()).toEqual(
      Object.values(Prisma.UserScalarFieldEnum).sort(),
    );
  });

  it("decides every table that holds a user's rows", () => {
    const decided: string[] = Object.values(USER_TABLES).flat();
    const withUser = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === "userId"))
      .map((model) => model.name);
    expect([...decided].sort()).toEqual([...withUser].sort());
  });

  it("states the retention period the policy sets", () => {
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ];
    expect(RETENTION_PERIOD_WORDS).toBe(
      `${words[RETENTION_YEARS_AFTER_CLOSURE]} years`,
    );
    expect(closureNotice(true)).toContain(RETENTION_PERIOD_WORDS);
    expect(accountClosedText(true)).toContain(RETENTION_PERIOD_WORDS);
  });
});

describe("closure copy", () => {
  it("tells an app user where to withdraw, and someone ops filed for how to stop it", () => {
    const dates = {
      eligibleAt: new Date("2026-10-16T10:00:00Z"),
      completeBy: new Date("2026-11-08T10:00:00Z"),
    };
    expect(closureRequestedText({ ...dates, via: "app" })).toBe(
      "your request to close your udara account is in. it can be closed from 16 october 2026, and we'll have done it by 8 november 2026. until then you can withdraw it in the app, under settings. keep your balance at zero until it's done.",
    );
    expect(closureRequestedText({ ...dates, via: "ops" })).toContain(
      "if you change your mind before then, reply here and we'll stop it.",
    );
  });

  it("promises nothing is kept to someone who never opened an account", () => {
    expect(closureNotice(false)).toBe(
      "we'll close your udara account and delete everything we hold about you.",
    );
    expect(accountClosedText(false)).not.toContain("keeping");
  });

  it("says why a closure is declined, without doubling the full stop", () => {
    expect(
      closureDeclinedText("a court has asked us to hold the records. "),
    ).toBe(
      "we can't close your udara account yet. a court has asked us to hold the records. we'll be in touch.",
    );
  });
});

describe("AccountClosureService", () => {
  const holder = {
    id: "user-1",
    phoneNumber: "2348012345678",
    whatsappNumber: "2348012345678",
    name: "Ada",
    email: "ada@example.com",
    rubiesAccountId: "cust-9",
    rubiesAccountNumber: "3312345678",
    rubiesAccountName: "ADA OBI",
    pinHash: null,
    closedAt: null,
  };
  const neverOpened = {
    ...holder,
    rubiesAccountId: null,
    rubiesAccountNumber: null,
    rubiesAccountName: null,
  };
  const eligibleRequest = {
    id: "req-1",
    userId: "user-1",
    type: SettingsChangeType.ACCOUNT_DELETION,
    status: SettingsChangeStatus.PENDING,
    requestedAt: new Date(now.getTime() - 10 * DAY),
    eligibleAt: new Date(now.getTime() - 3 * DAY),
  };

  let prisma: any;
  let rubies: { getBalance: jest.Mock };
  let manager: { fileChangeRequest: jest.Mock; withdrawRequest: jest.Mock };
  let messenger: { sendText: jest.Mock };
  let email: { sendAccountNotice: jest.Mock };
  let turns: { run: jest.Mock };
  let service: AccountClosureService;
  let order: string[];

  const model = () => ({
    count: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn(),
  });

  function withUser(user: Record<string, unknown>) {
    prisma.user.findUniqueOrThrow.mockResolvedValue(user);
    turns.run.mockImplementation((_id: string, _channel: string, fn: any) =>
      fn(user),
    );
  }

  beforeEach(() => {
    order = [];
    prisma = {};
    for (const name of [
      "user",
      "transaction",
      "billPayment",
      "incomingCredit",
      "overrideHistory",
      "settingsChangeRequest",
      "recipient",
      "whatsappMessage",
      "appMessage",
      "appSession",
      "loginChallenge",
      "device",
      "pinChallenge",
      "userTurnLease",
      "authOtp",
      "transferDraft",
      "billPaymentDraft",
      "conversationSession",
      "onboardingSession",
      "llmCallLog",
      "emailLog",
      "emailVerification",
      "nudgeLog",
      "weeklyReview",
      "dailyAllowance",
      "nameEnquiryLog",
    ]) {
      prisma[name] = model();
    }
    prisma.settingsChangeRequest.findUnique.mockResolvedValue(eligibleRequest);
    prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction = jest.fn(async (fn: any) => {
      order.push("transaction");
      return fn(prisma);
    });
    rubies = { getBalance: jest.fn().mockResolvedValue(0) };
    manager = {
      fileChangeRequest: jest.fn(async (params) => ({
        id: "req-new",
        ...params,
        status: SettingsChangeStatus.PENDING,
        requestedAt: now,
        eligibleAt: new Date(now.getTime() + 7 * DAY),
      })),
      withdrawRequest: jest.fn().mockResolvedValue({ ok: true }),
    };
    messenger = {
      sendText: jest.fn(async () => {
        order.push("message");
      }),
    };
    email = {
      sendAccountNotice: jest.fn(async () => {
        order.push("email");
      }),
    };
    turns = { run: jest.fn() };
    service = new AccountClosureService(
      prisma,
      rubies as any,
      manager as any,
      messenger as any,
      email as any,
      turns as any,
    );
    withUser(holder);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe("status", () => {
    it("reports an open request and the live balance", async () => {
      prisma.settingsChangeRequest.findFirst.mockResolvedValue(eligibleRequest);
      rubies.getBalance.mockResolvedValue(1500);

      const status = await service.status("user-1", now);

      expect(status).toEqual({
        openRequest: eligibleRequest,
        blockers: ["request_open", "balance_not_zero"],
        balance: 1500,
        hasAccount: true,
        pinSet: false,
      });
      expect(prisma.settingsChangeRequest.findFirst).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          type: SettingsChangeType.ACCOUNT_DELETION,
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        orderBy: { requestedAt: "desc" },
      });
    });

    it("asks Rubies nothing for someone with no account", async () => {
      withUser(neverOpened);

      const status = await service.status("user-1", now);

      expect(status).toEqual({
        openRequest: null,
        blockers: [],
        balance: null,
        hasAccount: false,
        pinSet: false,
      });
      expect(rubies.getBalance).not.toHaveBeenCalled();
    });

    it("cannot call it zero when Rubies does not answer", async () => {
      rubies.getBalance.mockRejectedValue(new Error("timeout"));

      const status = await service.status("user-1", now);

      expect(status.blockers).toEqual(["balance_unavailable"]);
      expect(status.balance).toBeNull();
    });

    it("counts a sent payment, and a fee the sweep may still collect, as in progress", async () => {
      prisma.transaction.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const status = await service.status("user-1", now);

      expect(status.blockers).toEqual(["payment_in_progress"]);
      expect(prisma.transaction.count).toHaveBeenCalledWith({
        where: { userId: "user-1", status: TransactionStatus.CONFIRMED },
      });
      expect(prisma.billPayment.count).toHaveBeenCalledWith({
        where: { userId: "user-1", status: BillPaymentStatus.CONFIRMED },
      });
      expect(prisma.transaction.count).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          status: TransactionStatus.EXECUTED,
          feeAmount: { gt: 0 },
          feeSweptAt: null,
          feeSweepAttempts: { lt: 5 },
          executedAt: { gte: new Date(now.getTime() - DAY) },
        },
      });
    });
  });

  describe("request", () => {
    it("files a closure with the fixed wording, then tells the user in the chat and by email", async () => {
      const authorize = jest.fn().mockResolvedValue(undefined);

      const result = await service.request(
        "user-1",
        { via: "app", reason: "moving abroad", authorize },
        now,
      );

      expect(authorize).toHaveBeenCalledWith(holder);
      expect(manager.fileChangeRequest).toHaveBeenCalledWith({
        userId: "user-1",
        type: SettingsChangeType.ACCOUNT_DELETION,
        requestedChange: CLOSURE_REQUEST_TEXT,
        reason: "moving abroad",
      });
      expect(result).toEqual({
        kind: "filed",
        request: expect.objectContaining({ id: "req-new" }),
        completeBy: new Date(now.getTime() + 30 * DAY),
      });
      const text = messenger.sendText.mock.calls[0][1];
      expect(text).toContain("until then you can withdraw it in the app");
      expect(messenger.sendText).toHaveBeenCalledWith(holder, text, {
        delivery: "transactional",
      });
      expect(email.sendAccountNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EmailType.ACCOUNT_CLOSURE_REQUESTED,
          requestId: "req-new",
          paragraphs: [text],
        }),
      );
    });

    it.each([
      ["an open request", "request_open"],
      ["money in the account", "balance_not_zero"],
      ["a payment in progress", "payment_in_progress"],
    ])(
      "is refused, without asking for the PIN, with %s",
      async (_what, blocker) => {
        if (blocker === "request_open") {
          prisma.settingsChangeRequest.findFirst.mockResolvedValue(
            eligibleRequest,
          );
        }
        if (blocker === "balance_not_zero")
          rubies.getBalance.mockResolvedValue(20);
        if (blocker === "payment_in_progress") {
          prisma.billPayment.count.mockResolvedValue(1);
        }
        const authorize = jest.fn();

        const result = await service.request(
          "user-1",
          { via: "app", authorize },
          now,
        );

        expect(result).toMatchObject({ kind: "blocked", blocker });
        expect(authorize).not.toHaveBeenCalled();
        expect(manager.fileChangeRequest).not.toHaveBeenCalled();
        expect(messenger.sendText).not.toHaveBeenCalled();
      },
    );

    it("files nothing when the PIN check throws", async () => {
      const authorize = jest.fn().mockRejectedValue(new Error("wrong_pin"));

      await expect(
        service.request("user-1", { via: "app", authorize }, now),
      ).rejects.toThrow("wrong_pin");
      expect(manager.fileChangeRequest).not.toHaveBeenCalled();
    });

    it("refuses a closed account", async () => {
      withUser({ ...holder, closedAt: now });

      await expect(
        service.request("user-1", { via: "ops" }, now),
      ).rejects.toMatchObject({ reason: "already_closed" });
    });
  });

  describe("close: refusals change nothing", () => {
    const expectNothingDone = () => {
      expect(messenger.sendText).not.toHaveBeenCalled();
      expect(email.sendAccountNotice).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    };

    it.each([
      ["an unknown request", { findUnique: null }, "not_found"],
      [
        "a request that is not a closure",
        { type: SettingsChangeType.EXIT_RESTRICTIONS },
        "not_a_closure",
      ],
      [
        "a decided request",
        { status: SettingsChangeStatus.WITHDRAWN },
        "already_decided",
      ],
      [
        "a request the user can still withdraw",
        { eligibleAt: new Date(now.getTime() + 60_000) },
        "not_eligible",
      ],
    ])("%s", async (_what, change, reason) => {
      prisma.settingsChangeRequest.findUnique.mockResolvedValue(
        "findUnique" in change ? null : { ...eligibleRequest, ...change },
      );

      await expect(service.close("req-1", {}, now)).rejects.toMatchObject({
        reason,
      });
      expectNothingDone();
    });

    it("an account that is already closed", async () => {
      withUser({ ...holder, closedAt: new Date(now.getTime() - DAY) });

      await expect(service.close("req-1", {}, now)).rejects.toBeInstanceOf(
        ClosureRefusedError,
      );
      expectNothingDone();
    });

    it("money in the account", async () => {
      rubies.getBalance.mockResolvedValue(0.5);

      await expect(service.close("req-1", {}, now)).rejects.toMatchObject({
        reason: "balance_not_zero",
      });
      expectNothingDone();
    });

    it("a payment in progress, even when ops has handled the balance", async () => {
      prisma.transaction.count.mockResolvedValueOnce(1);

      await expect(
        service.close("req-1", { residualHandled: true }, now),
      ).rejects.toMatchObject({ reason: "payment_in_progress" });
      expectNothingDone();
    });

    it("a request another operator decided first: rolled back before any erasure", async () => {
      prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.close("req-1", {}, now)).rejects.toMatchObject({
        reason: "already_decided",
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.device.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("close: an account holder", () => {
    it("confirms first, then claims the request and erases, in one transaction under the turn lease", async () => {
      await service.close("req-1", { notes: "asked in app" }, now);

      expect(turns.run).toHaveBeenCalledWith(
        "user-1",
        "app",
        expect.any(Function),
      );
      expect(order).toEqual(["message", "email", "transaction"]);
      expect(messenger.sendText).toHaveBeenCalledWith(
        holder,
        accountClosedText(true),
        { delivery: "transactional" },
      );
      expect(email.sendAccountNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EmailType.ACCOUNT_CLOSED,
          requestId: "req-1",
        }),
      );
      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        data: {
          status: SettingsChangeStatus.APPROVED,
          resolvedAt: now,
          managerNotes: "asked in app",
        },
      });
      // Then anything else left open with the managers, after the claim.
      const calls = prisma.settingsChangeRequest.updateMany.mock.calls;
      expect(calls[1][0]).toEqual({
        where: {
          userId: "user-1",
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        data: { status: SettingsChangeStatus.WITHDRAWN, resolvedAt: now },
      });
    });

    it("keeps the identity, releases the numbers, and erases the plan, the profile and the PIN", async () => {
      await service.close("req-1", {}, now);

      const { data } = prisma.user.update.mock.calls[0][0];
      expect(data).toMatchObject({
        closedAt: now,
        closedPhoneNumber: "2348012345678",
        phoneNumber: "closed:user-1",
        whatsappNumber: null,
        name: null,
        monthlyIncome: null,
        statedGoal: null,
        pinHash: null,
        pinFailedAttempts: 0,
        windowStartHour: 11,
        windowEndHour: 20,
      });
      for (const field of USER_FIELDS.erased) {
        expect(data).toHaveProperty(field);
      }
      for (const field of USER_FIELDS.identity) {
        expect(data).not.toHaveProperty(field);
      }
    });

    it("keeps the payment records and the conversation, and deletes the working data", async () => {
      await service.close("req-1", {}, now);

      for (const kept of [
        "transaction",
        "billPayment",
        "incomingCredit",
        "overrideHistory",
        "settingsChangeRequest",
        "whatsappMessage",
        "appMessage",
      ]) {
        expect(prisma[kept].deleteMany).not.toHaveBeenCalled();
      }
      for (const table of USER_TABLES.deleted) {
        const delegate = table.charAt(0).toLowerCase() + table.slice(1);
        expect(prisma[delegate].deleteMany).toHaveBeenCalledWith({
          where: { userId: "user-1" },
        });
      }
      expect(prisma.authOtp.deleteMany).toHaveBeenCalledWith({
        where: { phoneNumber: "2348012345678" },
      });
    });

    it("cancels quotes nobody confirmed, and keeps paid recipients without the user's labels", async () => {
      await service.close("req-1", {}, now);

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          status: {
            in: [
              TransactionStatus.PENDING_CONFIRMATION,
              TransactionStatus.PENDING_PIN,
            ],
          },
        },
        data: { status: TransactionStatus.CANCELLED },
      });
      expect(prisma.billPayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: BillPaymentStatus.CANCELLED },
        }),
      );
      expect(prisma.recipient.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", transactions: { none: {} } },
      });
      expect(prisma.recipient.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        data: { nickname: null, label: RecipientLabel.OTHER, lastUsedAt: null },
      });
    });

    it("hands ops the Rubies details and the date the records are kept until", async () => {
      const result = await service.close("req-1", {}, now);

      expect(result).toMatchObject({
        userId: "user-1",
        recordsKept: true,
        recordsKeptUntil: new Date("2032-10-20T09:00:00Z"),
        rubies: {
          customerId: "cust-9",
          accountNumber: "3312345678",
          accountName: "ADA OBI",
        },
      });
    });

    it("skips only the balance check when ops has handled a residual", async () => {
      rubies.getBalance.mockResolvedValue(3.2);

      await service.close("req-1", { residualHandled: true }, now);

      expect(rubies.getBalance).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  describe("close: someone who never opened an account", () => {
    beforeEach(() => withUser(neverOpened));

    it("erases the identity and the conversation too, keeping only a request with no words in it", async () => {
      const result = await service.close("req-1", {}, now);

      const { data } = prisma.user.update.mock.calls[0][0];
      expect(data).toMatchObject({
        closedPhoneNumber: null,
        phoneNumber: "closed:user-1",
        email: null,
        legalFirstName: null,
        dateOfBirth: null,
        termsAcceptedAt: null,
      });
      expect(prisma.whatsappMessage.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { userId: "user-1" },
            { userId: null, fromNumber: "2348012345678" },
          ],
        },
      });
      expect(prisma.appMessage.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          type: { not: SettingsChangeType.ACCOUNT_DELETION },
        },
        data: { requestedChange: ERASED_REQUEST_TEXT },
      });
      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        data: { reason: null, managerNotes: null },
      });
      expect(prisma.settingsChangeRequest.deleteMany).not.toHaveBeenCalled();
      expect(messenger.sendText).toHaveBeenCalledWith(
        neverOpened,
        accountClosedText(false),
        { delivery: "transactional" },
      );
      expect(result).toMatchObject({
        recordsKept: false,
        recordsKeptUntil: null,
        rubies: null,
      });
      expect(rubies.getBalance).not.toHaveBeenCalled();
    });
  });

  describe("decline and withdraw", () => {
    it("declines with the operator's reason, told to the user plainly", async () => {
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        ...eligibleRequest,
        status: SettingsChangeStatus.REJECTED,
      });

      await service.decline(
        "req-1",
        "a court has asked us to hold the records",
        now,
      );

      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        data: {
          status: SettingsChangeStatus.REJECTED,
          resolvedAt: now,
          managerNotes: "a court has asked us to hold the records",
        },
      });
      expect(messenger.sendText).toHaveBeenCalledWith(
        holder,
        closureDeclinedText("a court has asked us to hold the records"),
        { delivery: "transactional" },
      );
    });

    it("cannot decline a decided request", async () => {
      prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.decline("req-1", "hold", now)).rejects.toMatchObject(
        {
          reason: "already_decided",
        },
      );
      expect(messenger.sendText).not.toHaveBeenCalled();
    });

    it("withdraws on the request owner's behalf", async () => {
      await service.withdraw("req-1", now);

      expect(manager.withdrawRequest).toHaveBeenCalledWith(
        "user-1",
        "req-1",
        now,
      );
    });

    it("will not withdraw something that is not a closure through this path", async () => {
      prisma.settingsChangeRequest.findUnique.mockResolvedValue({
        ...eligibleRequest,
        type: SettingsChangeType.OTHER,
      });

      await expect(service.withdraw("req-1", now)).rejects.toMatchObject({
        reason: "not_a_closure",
      });
    });
  });
});
