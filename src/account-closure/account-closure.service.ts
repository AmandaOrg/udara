import { Injectable, Logger } from "@nestjs/common";
import {
  BillPaymentStatus,
  BudgetMethod,
  EmailType,
  IncomePosture,
  Prisma,
  RecipientLabel,
  SettingsChangeRequest,
  SettingsChangeStatus,
  SettingsChangeType,
  TransactionStatus,
  User,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { RubiesService } from "../rubies/rubies.service";
import {
  ManagerService,
  OPEN_REQUEST_STATUSES,
} from "../manager/manager.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { EmailNotificationsService } from "../email/email-notifications.service";
import { TurnService } from "../conversation/turn.service";
import {
  FEE_SWEEP_GIVE_UP_MS,
  FEE_SWEEP_MAX_ATTEMPTS,
} from "../whatsapp/transfer-confirmation.service";
import { closureDueBy, recordsKeptUntil } from "./retention-policy";
import {
  accountClosedText,
  closureDeclinedText,
  closureRequestedText,
} from "./closure-copy";

/** Why a closure cannot be asked for, or carried out, right now. */
export type ClosureBlocker =
  | "request_open"
  | "payment_in_progress"
  | "balance_unavailable"
  | "balance_not_zero";

export interface ClosureStatus {
  openRequest: SettingsChangeRequest | null;
  blockers: ClosureBlocker[];
  /** Live from Rubies; null with no account, or when Rubies did not answer. */
  balance: number | null;
  hasAccount: boolean;
  /** The app asks for the PIN only when one is set. */
  pinSet: boolean;
}

export type ClosureRequestResult =
  | { kind: "filed"; request: SettingsChangeRequest; completeBy: Date }
  | {
      kind: "blocked";
      blocker: ClosureBlocker;
      balance: number | null;
      openRequest: SettingsChangeRequest | null;
    };

export type ClosureRefusal =
  | "not_found"
  | "not_a_closure"
  | "already_decided"
  | "not_eligible"
  | "already_closed"
  | Exclude<ClosureBlocker, "request_open">;

/** An operator asked for something the request or the account does not allow. */
export class ClosureRefusedError extends Error {
  constructor(
    readonly reason: ClosureRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ClosureRefusedError";
  }
}

/** What a dry run reports: what stands in the way, and what would happen. */
export interface ClosurePlan {
  requestId: string;
  userId: string;
  recordsKept: boolean;
  blockers: Exclude<ClosureBlocker, "request_open">[];
  balance: number | null;
  rows: Record<string, { rows: number; action: "kept" | "erased" }>;
}

export interface ClosureResult {
  userId: string;
  closedAt: Date;
  recordsKept: boolean;
  recordsKeptUntil: Date | null;
  /** For ops to ask Rubies to close the bank account. */
  rubies: {
    customerId: string | null;
    accountNumber: string;
    accountName: string | null;
  } | null;
  erased: Record<string, number>;
}

/** The fixed wording on a closure request; the user's own words go in `reason`. */
export const CLOSURE_REQUEST_TEXT = "close my account";
/** What replaces a never-opened user's own words on their other requests. */
export const ERASED_REQUEST_TEXT = "(erased when the account was closed)";

/**
 * ADR-0003, field by field. Every scalar on User is in exactly one list, and
 * a test fails when a new column appears without a decision here.
 */
export const USER_FIELDS = {
  /** Identity from account opening: kept for an account holder, erased otherwise. */
  identity: [
    "legalFirstName",
    "legalMiddleName",
    "legalLastName",
    "dateOfBirth",
    "email",
    "emailVerifiedAt",
    "rubiesAccountId",
    "rubiesAccountNumber",
    "rubiesAccountName",
    "rubiesBankCode",
    "termsAcceptedAt",
    "termsVersion",
    "onboardingCompletedAt",
  ],
  /** The plan, the profile and the PIN: erased for everyone. */
  erased: [
    "name",
    "occupation",
    "city",
    "monthlyIncome",
    "incomeType",
    "incomePosture",
    "budgetMethod",
    "budgetPercentage",
    "flatDailyAmount",
    "strictnessLevel",
    "statedGoal",
    "statedGoalSetAt",
    "windowStartHour",
    "windowEndHour",
    "disciplineExitedAt",
    "dailyLimitOverride",
    "dailyLimitOverrideWeekStart",
    "bvn",
    "nin",
    "lastInboundMessageAt",
    "lastAppActiveAt",
    "pinHash",
    "pinSetAt",
    "pinFailedAttempts",
    "pinLockedUntil",
  ],
  /** Rewritten by closure itself: the numbers are released, the closure recorded. */
  closure: ["phoneNumber", "whatsappNumber", "closedAt", "closedPhoneNumber"],
  /** Carry nothing about the person. */
  bookkeeping: ["id", "onboardingStage", "createdAt", "updatedAt"],
} as const;

/**
 * ADR-0003, table by table: every model that belongs to a user. A test fails
 * when a model with a userId appears without a decision here.
 */
export const USER_TABLES = {
  /** Payment records and account files: kept for everyone who has them. */
  kept: [
    "Transaction",
    "BillPayment",
    "IncomingCredit",
    "OverrideHistory",
    "SettingsChangeRequest",
  ],
  /** Business correspondence: kept for an account holder, deleted otherwise. */
  conversation: ["WhatsappMessage", "AppMessage"],
  /** Paid recipients are part of the payment record; the rest are deleted. */
  partly: ["Recipient"],
  /** Working data: deleted for everyone. */
  deleted: [
    "AppSession",
    "LoginChallenge",
    "Device",
    "PinChallenge",
    "UserTurnLease",
    "TransferDraft",
    "BillPaymentDraft",
    "ConversationSession",
    "OnboardingSession",
    "LlmCallLog",
    "EmailLog",
    "EmailVerification",
    "NudgeLog",
    "WeeklyReview",
    "DailyAllowance",
    "NameEnquiryLog",
  ],
} as const;

/** The plan and profile, as closure leaves them: empty, or the schema's default. */
const ERASED_PROFILE = {
  name: null,
  occupation: null,
  city: null,
  monthlyIncome: null,
  incomeType: null,
  incomePosture: IncomePosture.RESTRICT,
  budgetMethod: BudgetMethod.FLAT,
  budgetPercentage: null,
  flatDailyAmount: null,
  strictnessLevel: null,
  statedGoal: null,
  statedGoalSetAt: null,
  windowStartHour: 11,
  windowEndHour: 20,
  disciplineExitedAt: null,
  dailyLimitOverride: null,
  dailyLimitOverrideWeekStart: null,
  bvn: null,
  nin: null,
  lastInboundMessageAt: null,
  lastAppActiveAt: null,
  pinHash: null,
  pinSetAt: null,
  pinFailedAttempts: 0,
  pinLockedUntil: null,
} satisfies Record<(typeof USER_FIELDS.erased)[number], unknown>;

const ERASED_IDENTITY = {
  legalFirstName: null,
  legalMiddleName: null,
  legalLastName: null,
  dateOfBirth: null,
  email: null,
  emailVerifiedAt: null,
  rubiesAccountId: null,
  rubiesAccountNumber: null,
  rubiesAccountName: null,
  rubiesBankCode: null,
  termsAcceptedAt: null,
  termsVersion: null,
  onboardingCompletedAt: null,
} satisfies Record<(typeof USER_FIELDS.identity)[number], null>;

/** A bank account was opened: a business relationship whose records the law keeps. */
export function isAccountHolder(
  user: Pick<User, "rubiesAccountNumber" | "rubiesAccountId">,
): boolean {
  return Boolean(user.rubiesAccountNumber || user.rubiesAccountId);
}

/** Long enough for an account with years of messages. */
const CLOSURE_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Closing an account (ADR-0003): asking for it, and the operator carrying it
 * out. Closure erases data and cannot be undone, so every check runs again at
 * the moment of closing, the erasure is one transaction, and it runs under the
 * user's turn lease so a message in progress cannot write anything back.
 */
@Injectable()
export class AccountClosureService {
  private readonly logger = new Logger(AccountClosureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly manager: ManagerService,
    private readonly messenger: ChannelMessenger,
    private readonly emailNotifications: EmailNotificationsService,
    private readonly turns: TurnService,
  ) {}

  /** What the app shows before asking: anything in the way, and any open request. */
  async status(userId: string, now: Date = new Date()): Promise<ClosureStatus> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const openRequest = await this.openRequest(userId);
    const { blockers, balance } = await this.check(user, now);
    return {
      openRequest,
      blockers: openRequest ? ["request_open", ...blockers] : blockers,
      balance,
      hasAccount: isAccountHolder(user),
      pinSet: user.pinHash !== null,
    };
  }

  /**
   * Files the request once nothing stands in the way. `authorize` runs last,
   * just before filing, so a PIN is never spent on a request that would have
   * been refused anyway; it throws to stop the request (the app's PIN check).
   */
  async request(
    userId: string,
    params: {
      via: "app" | "ops";
      reason?: string;
      authorize?: (user: User) => Promise<void>;
    },
    now: Date = new Date(),
  ): Promise<ClosureRequestResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.closedAt) {
      throw new ClosureRefusedError(
        "already_closed",
        `User ${userId} is already closed`,
      );
    }

    const openRequest = await this.openRequest(userId);
    if (openRequest) {
      return {
        kind: "blocked",
        blocker: "request_open",
        balance: null,
        openRequest,
      };
    }
    const { blockers, balance } = await this.check(user, now);
    if (blockers.length > 0) {
      return {
        kind: "blocked",
        blocker: blockers[0],
        balance,
        openRequest: null,
      };
    }

    await params.authorize?.(user);

    // ManagerService, not ManagerConversationService: the same seven-day
    // eligibleAt, but no managers' reply. Holding someone's goal against them
    // as they ask to leave would make leaving harder than it should be.
    const request = await this.manager.fileChangeRequest({
      userId,
      type: SettingsChangeType.ACCOUNT_DELETION,
      requestedChange: CLOSURE_REQUEST_TEXT,
      reason: params.reason,
    });
    const completeBy = closureDueBy(request.requestedAt);
    const text = closureRequestedText({
      eligibleAt: request.eligibleAt,
      completeBy,
      via: params.via,
    });
    await this.messenger.sendText(user, text, { delivery: "transactional" });
    await this.emailNotifications.sendAccountNotice({
      user,
      type: EmailType.ACCOUNT_CLOSURE_REQUESTED,
      requestId: request.id,
      subject: "Your request to close your Udara account",
      heading: "closing your account",
      paragraphs: [text],
    });

    this.logger.log(
      `Closure requested for user ${userId} (request ${request.id}, via ${params.via})`,
    );
    return { kind: "filed", request, completeBy };
  }

  /** The dry run: everything close() would check and do, writing nothing. */
  async plan(requestId: string, now: Date = new Date()): Promise<ClosurePlan> {
    const { user } = await this.loadClosable(requestId, now);
    const recordsKept = isAccountHolder(user);
    const { blockers, balance } = await this.check(user, now);
    return {
      requestId,
      userId: user.id,
      recordsKept,
      blockers,
      balance,
      rows: await this.countRows(user, recordsKept),
    };
  }

  /**
   * Closes the account. Refuses, changing nothing, unless the request is an
   * undecided, eligible closure and nothing stands in the way.
   * `residualHandled` skips only the balance check, for an amount ops has
   * already arranged with Rubies.
   */
  async close(
    requestId: string,
    options: { residualHandled?: boolean; notes?: string } = {},
    now: Date = new Date(),
  ): Promise<ClosureResult> {
    const { user } = await this.loadClosable(requestId, now);

    return this.turns.run(user.id, "app", async (current) => {
      if (current.closedAt) {
        throw new ClosureRefusedError(
          "already_closed",
          `User ${current.id} is already closed`,
        );
      }
      const { blockers, balance } = await this.check(current, now, {
        skipBalance: options.residualHandled,
      });
      if (blockers.length > 0) {
        throw new ClosureRefusedError(
          blockers[0],
          blockers[0] === "balance_not_zero"
            ? `The balance is ₦${balance}. Move it out, or arrange it with Rubies and pass --residual-handled.`
            : `Cannot close yet: ${blockers.join(", ")}`,
        );
      }

      const recordsKept = isAccountHolder(current);

      // The confirmation goes first, while there are still channels to send
      // it on. If the transaction below then fails, the operator sees the
      // error and runs this again; the email's dedupe key stops a second copy.
      const text = accountClosedText(recordsKept);
      await this.messenger.sendText(current, text, {
        delivery: "transactional",
      });
      await this.emailNotifications.sendAccountNotice({
        user: current,
        type: EmailType.ACCOUNT_CLOSED,
        requestId,
        subject: "Your Udara account is closed",
        heading: "your account is closed",
        paragraphs: [text],
      });

      const erased = await this.prisma.$transaction(
        async (tx) => {
          const claim = await tx.settingsChangeRequest.updateMany({
            where: { id: requestId, status: { in: OPEN_REQUEST_STATUSES } },
            data: {
              status: SettingsChangeStatus.APPROVED,
              resolvedAt: now,
              managerNotes: options.notes ?? null,
            },
          });
          if (claim.count !== 1) {
            throw new ClosureRefusedError(
              "already_decided",
              `Request ${requestId} was decided by someone else first`,
            );
          }
          // Anything else the user had open with the managers goes with the
          // account: left open, it would wait for a decision nobody can act
          // on, and the managers' reply would be generated for no one.
          await tx.settingsChangeRequest.updateMany({
            where: {
              userId: current.id,
              status: { in: OPEN_REQUEST_STATUSES },
            },
            data: { status: SettingsChangeStatus.WITHDRAWN, resolvedAt: now },
          });
          return this.erase(tx, current, recordsKept, now);
        },
        { timeout: CLOSURE_TRANSACTION_TIMEOUT_MS },
      );

      this.logger.log(
        `Closed the account of user ${current.id} (request ${requestId}); ${recordsKept ? "records kept" : "nothing kept"}`,
      );
      return {
        userId: current.id,
        closedAt: now,
        recordsKept,
        recordsKeptUntil: recordsKept ? recordsKeptUntil(now) : null,
        rubies: current.rubiesAccountNumber
          ? {
              customerId: current.rubiesAccountId,
              accountNumber: current.rubiesAccountNumber,
              accountName: current.rubiesAccountName,
            }
          : null,
        erased,
      };
    });
  }

  /** An operator cannot close it yet (a hold, for example), and says why. */
  async decline(
    requestId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<SettingsChangeRequest> {
    const request = await this.findClosureRequest(requestId);
    const { count } = await this.prisma.settingsChangeRequest.updateMany({
      where: { id: requestId, status: { in: OPEN_REQUEST_STATUSES } },
      data: {
        status: SettingsChangeStatus.REJECTED,
        resolvedAt: now,
        managerNotes: reason,
      },
    });
    if (count !== 1) {
      throw new ClosureRefusedError(
        "already_decided",
        `Request ${requestId} has already been decided`,
      );
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
    });
    await this.messenger.sendText(user, closureDeclinedText(reason), {
      delivery: "transactional",
    });
    return this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
  }

  /** Withdraws a closure on the user's behalf, when they asked another way. */
  async withdraw(requestId: string, now: Date = new Date()) {
    const request = await this.findClosureRequest(requestId);
    return this.manager.withdrawRequest(request.userId, requestId, now);
  }

  private openRequest(userId: string) {
    return this.prisma.settingsChangeRequest.findFirst({
      where: {
        userId,
        type: SettingsChangeType.ACCOUNT_DELETION,
        status: { in: OPEN_REQUEST_STATUSES },
      },
      orderBy: { requestedAt: "desc" },
    });
  }

  private async findClosureRequest(
    requestId: string,
  ): Promise<SettingsChangeRequest> {
    const request = await this.prisma.settingsChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new ClosureRefusedError("not_found", `No request ${requestId}`);
    }
    if (request.type !== SettingsChangeType.ACCOUNT_DELETION) {
      throw new ClosureRefusedError(
        "not_a_closure",
        `Request ${requestId} is a ${request.type} request, not a closure`,
      );
    }
    return request;
  }

  private async loadClosable(requestId: string, now: Date) {
    const request = await this.findClosureRequest(requestId);
    if (!OPEN_REQUEST_STATUSES.includes(request.status)) {
      throw new ClosureRefusedError(
        "already_decided",
        `Request ${requestId} is already ${request.status}`,
      );
    }
    if (request.eligibleAt > now) {
      throw new ClosureRefusedError(
        "not_eligible",
        `Request ${requestId} cannot be closed before ${request.eligibleAt.toISOString()}: the user may still withdraw it`,
      );
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
    });
    if (user.closedAt) {
      throw new ClosureRefusedError(
        "already_closed",
        `User ${user.id} is already closed`,
      );
    }
    return { request, user };
  }

  /** What stands in the way, apart from an open request. */
  private async check(
    user: User,
    now: Date,
    options: { skipBalance?: boolean } = {},
  ): Promise<{
    blockers: Exclude<ClosureBlocker, "request_open">[];
    balance: number | null;
  }> {
    const blockers: Exclude<ClosureBlocker, "request_open">[] = [];
    if (await this.paymentInProgress(user.id, now)) {
      blockers.push("payment_in_progress");
    }

    let balance: number | null = null;
    if (user.rubiesAccountNumber && !options.skipBalance) {
      try {
        balance = await this.rubies.getBalance(user.rubiesAccountNumber);
      } catch (err) {
        this.logger.warn(
          `Balance check for user ${user.id}'s closure failed: ${err instanceof Error ? err.name : "unknown error"}`,
        );
      }
      if (balance === null) blockers.push("balance_unavailable");
      else if (balance > 0) blockers.push("balance_not_zero");
    }
    return { blockers, balance };
  }

  /**
   * Money still moving: a payment sent to Rubies and not yet answered, or a
   * fee the sweep may still collect (it retries for a day, then gives up).
   */
  private async paymentInProgress(userId: string, now: Date): Promise<boolean> {
    const [transfers, bills, fees] = await Promise.all([
      this.prisma.transaction.count({
        where: { userId, status: TransactionStatus.CONFIRMED },
      }),
      this.prisma.billPayment.count({
        where: { userId, status: BillPaymentStatus.CONFIRMED },
      }),
      this.prisma.transaction.count({
        where: {
          userId,
          status: TransactionStatus.EXECUTED,
          feeAmount: { gt: 0 },
          feeSweptAt: null,
          feeSweepAttempts: { lt: FEE_SWEEP_MAX_ATTEMPTS },
          executedAt: { gte: new Date(now.getTime() - FEE_SWEEP_GIVE_UP_MS) },
        },
      }),
    ]);
    return transfers + bills + fees > 0;
  }

  /** The erasure itself, inside the closing transaction. */
  private async erase(
    tx: Prisma.TransactionClient,
    user: User,
    recordsKept: boolean,
    now: Date,
  ): Promise<Record<string, number>> {
    const userId = user.id;
    const erased: Record<string, number> = {};
    const note = (what: string, result: { count: number }) => {
      erased[what] = result.count;
    };

    // Quotes nobody confirmed are cancelled, as any abandoned quote is. The
    // payment records themselves are never deleted (S18).
    note(
      "quotesCancelled",
      await tx.transaction.updateMany({
        where: {
          userId,
          status: {
            in: [
              TransactionStatus.PENDING_CONFIRMATION,
              TransactionStatus.PENDING_PIN,
            ],
          },
        },
        data: { status: TransactionStatus.CANCELLED },
      }),
    );
    note(
      "billQuotesCancelled",
      await tx.billPayment.updateMany({
        where: {
          userId,
          status: {
            in: [
              BillPaymentStatus.PENDING_CONFIRMATION,
              BillPaymentStatus.PENDING_PIN,
            ],
          },
        },
        data: { status: BillPaymentStatus.CANCELLED },
      }),
    );

    // Signed out everywhere. Sessions and challenges go before the devices
    // they point at.
    note("AppSession", await tx.appSession.deleteMany({ where: { userId } }));
    note(
      "LoginChallenge",
      await tx.loginChallenge.deleteMany({ where: { userId } }),
    );
    note("Device", await tx.device.deleteMany({ where: { userId } }));
    note(
      "PinChallenge",
      await tx.pinChallenge.deleteMany({ where: { userId } }),
    );
    note(
      "UserTurnLease",
      await tx.userTurnLease.deleteMany({ where: { userId } }),
    );
    note(
      "AuthOtp",
      await tx.authOtp.deleteMany({ where: { phoneNumber: user.phoneNumber } }),
    );

    // Working data.
    note(
      "TransferDraft",
      await tx.transferDraft.deleteMany({ where: { userId } }),
    );
    note(
      "BillPaymentDraft",
      await tx.billPaymentDraft.deleteMany({ where: { userId } }),
    );
    note(
      "ConversationSession",
      await tx.conversationSession.deleteMany({ where: { userId } }),
    );
    note(
      "OnboardingSession",
      await tx.onboardingSession.deleteMany({ where: { userId } }),
    );
    note("LlmCallLog", await tx.llmCallLog.deleteMany({ where: { userId } }));
    note("EmailLog", await tx.emailLog.deleteMany({ where: { userId } }));
    note(
      "EmailVerification",
      await tx.emailVerification.deleteMany({ where: { userId } }),
    );
    note("NudgeLog", await tx.nudgeLog.deleteMany({ where: { userId } }));
    note(
      "WeeklyReview",
      await tx.weeklyReview.deleteMany({ where: { userId } }),
    );
    // Payments' links to these become null through the foreign key.
    note(
      "DailyAllowance",
      await tx.dailyAllowance.deleteMany({ where: { userId } }),
    );
    note(
      "NameEnquiryLog",
      await tx.nameEnquiryLog.deleteMany({ where: { userId } }),
    );

    // A paid recipient is part of the payment record: it is the only place
    // the account paid is held. The user's own labels on it are not.
    note(
      "Recipient",
      await tx.recipient.deleteMany({
        where: { userId, transactions: { none: {} } },
      }),
    );
    await tx.recipient.updateMany({
      where: { userId },
      data: { nickname: null, label: RecipientLabel.OTHER, lastUsedAt: null },
    });

    if (!recordsKept) {
      // No account was ever opened, so there is no business correspondence to
      // keep (GAID Art. 21(2)): the conversation goes too, including WhatsApp
      // rows from the number that were never attached to the user.
      note(
        "WhatsappMessage",
        await tx.whatsappMessage.deleteMany({
          where: {
            OR: [
              { userId },
              ...(user.whatsappNumber
                ? [{ userId: null, fromNumber: user.whatsappNumber }]
                : []),
            ],
          },
        }),
      );
      note("AppMessage", await tx.appMessage.deleteMany({ where: { userId } }));
      // The requests stay as evidence that this one was handled, without the
      // user's words or anything an operator wrote about them.
      await tx.settingsChangeRequest.updateMany({
        where: { userId, type: { not: SettingsChangeType.ACCOUNT_DELETION } },
        data: { requestedChange: ERASED_REQUEST_TEXT },
      });
      await tx.settingsChangeRequest.updateMany({
        where: { userId },
        data: { reason: null, managerNotes: null },
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        ...ERASED_PROFILE,
        ...(recordsKept ? {} : ERASED_IDENTITY),
        closedAt: now,
        // Released, so the number can start a new account and this one can
        // never be signed in to again. An account holder's is kept as a record.
        closedPhoneNumber: recordsKept ? user.phoneNumber : null,
        phoneNumber: `closed:${userId}`,
        whatsappNumber: null,
      },
    });

    return erased;
  }

  /** Row counts for the dry run, against the tables in USER_TABLES. */
  private async countRows(
    user: User,
    recordsKept: boolean,
  ): Promise<ClosurePlan["rows"]> {
    const userId = user.id;
    const p = this.prisma;
    const counts: [string, Promise<number>, boolean][] = [
      ["Transaction", p.transaction.count({ where: { userId } }), true],
      ["BillPayment", p.billPayment.count({ where: { userId } }), true],
      ["IncomingCredit", p.incomingCredit.count({ where: { userId } }), true],
      ["OverrideHistory", p.overrideHistory.count({ where: { userId } }), true],
      [
        "SettingsChangeRequest",
        p.settingsChangeRequest.count({ where: { userId } }),
        true,
      ],
      [
        "WhatsappMessage",
        p.whatsappMessage.count({ where: { userId } }),
        recordsKept,
      ],
      ["AppMessage", p.appMessage.count({ where: { userId } }), recordsKept],
      [
        "Recipient (paid)",
        p.recipient.count({ where: { userId, transactions: { some: {} } } }),
        true,
      ],
      [
        "Recipient (never paid)",
        p.recipient.count({ where: { userId, transactions: { none: {} } } }),
        false,
      ],
      ["Device", p.device.count({ where: { userId } }), false],
      ["AppSession", p.appSession.count({ where: { userId } }), false],
      [
        "ConversationSession",
        p.conversationSession.count({ where: { userId } }),
        false,
      ],
      [
        "OnboardingSession",
        p.onboardingSession.count({ where: { userId } }),
        false,
      ],
      ["LlmCallLog", p.llmCallLog.count({ where: { userId } }), false],
      ["EmailLog", p.emailLog.count({ where: { userId } }), false],
      ["DailyAllowance", p.dailyAllowance.count({ where: { userId } }), false],
    ];
    const rows: ClosurePlan["rows"] = {};
    for (const [table, count, kept] of counts) {
      rows[table] = { rows: await count, action: kept ? "kept" : "erased" };
    }
    return rows;
  }
}
