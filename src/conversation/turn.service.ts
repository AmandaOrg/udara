import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  BillPaymentDraftStatus,
  ConversationPersona,
  ConversationSessionStatus,
  MessageChannel,
  Prisma,
  TransferDraftStatus,
  User,
  WeeklyReviewStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { Channel, toMessageChannel } from "../messaging/channel-context";

/** Longer than any real turn (an LLM call, a Rubies call), so it only ever expires a crashed one. */
export const TURN_LEASE_TTL_MS = 90_000;
/** How long a turn waits for the previous one before running anyway. */
export const TURN_WAIT_MS = 45_000;
const RETRY_EVERY_MS = 200;

/**
 * One conversational turn per user at a time, whichever channel it arrives on.
 *
 * Every turn reads and rewrites shared state: the onboarding session, the
 * orchestrator's history, an open wizard. Two turns interleaving (two quick
 * WhatsApp messages, or one on WhatsApp and one in the app) can each read the
 * state the other is about to replace. The lease is a database row so it holds
 * across replicas.
 *
 * It also notices when the user changes channel. A wizard opened on WhatsApp
 * that is still waiting for an amount would otherwise read the next number
 * typed in the app as that amount, so on a switch everything left open is
 * quietly expired.
 */
@Injectable()
export class TurnService {
  private readonly logger = new Logger(TurnService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `fn` as this user's turn on `channel`. `fn` receives the user as read
   * after the lease is held, not before, since the turn it waited for may have
   * moved them on (to a new onboarding stage, for one).
   */
  async run<T>(
    userId: string,
    channel: Channel,
    fn: (user: User) => Promise<T>,
  ): Promise<T> {
    const holder = randomUUID();
    const lease = await this.acquire(userId, holder);
    try {
      if (lease) {
        await this.noteChannel(userId, holder, lease.lastChannel, channel);
      }
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      return await fn(user);
    } finally {
      if (lease) await this.release(userId, holder);
    }
  }

  // Not private so tests can skip real waiting.
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Null when the wait ran out. The turn then runs without the lease, which is
   * exactly how every turn ran before it existed: better a rare race than a
   * message that is never answered because an earlier turn hung.
   */
  private async acquire(
    userId: string,
    holder: string,
  ): Promise<{ lastChannel: MessageChannel | null } | null> {
    const deadline = Date.now() + TURN_WAIT_MS;
    for (;;) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TURN_LEASE_TTL_MS);

      const { count } = await this.prisma.userTurnLease.updateMany({
        where: { userId, expiresAt: { lte: now } },
        data: { holder, expiresAt },
      });
      if (count === 1) {
        const row = await this.prisma.userTurnLease.findUnique({
          where: { userId },
          select: { lastChannel: true },
        });
        return { lastChannel: row?.lastChannel ?? null };
      }

      try {
        await this.prisma.userTurnLease.create({
          data: { userId, holder, expiresAt },
        });
        return { lastChannel: null };
      } catch (err) {
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== "P2002"
        ) {
          throw err;
        }
        // The row exists and is held by a live turn.
      }

      if (Date.now() >= deadline) {
        this.logger.warn(
          `user ${userId}: the previous turn still holds the lease after ${TURN_WAIT_MS / 1000}s; running this turn without it`,
        );
        return null;
      }
      await this.sleep(RETRY_EVERY_MS);
    }
  }

  private async noteChannel(
    userId: string,
    holder: string,
    previous: MessageChannel | null,
    channel: Channel,
  ): Promise<void> {
    const current = toMessageChannel(channel);
    // No record means no turn since this existed, and every turn before it was
    // on WhatsApp.
    if ((previous ?? MessageChannel.WHATSAPP) !== current) {
      await this.expireOpenSurfaces(userId, current);
    }
    if (previous !== current) {
      await this.prisma.userTurnLease.updateMany({
        where: { userId, holder },
        data: { lastChannel: current },
      });
    }
  }

  /**
   * Quietly, because the user has moved on: telling them on the new channel
   * that something on the old one lapsed would be noise about a conversation
   * they are no longer looking at. Confirmations waiting on a button and PIN
   * challenges are left alone; they can only be acted on through their own
   * button or token, so they cannot capture stray input.
   */
  private async expireOpenSurfaces(
    userId: string,
    now: MessageChannel,
  ): Promise<void> {
    const transfers = await this.prisma.transferDraft.updateMany({
      where: { userId, status: TransferDraftStatus.ACTIVE },
      data: { status: TransferDraftStatus.CANCELLED },
    });
    const bills = await this.prisma.billPaymentDraft.updateMany({
      where: { userId, status: BillPaymentDraftStatus.ACTIVE },
      data: { status: BillPaymentDraftStatus.CANCELLED },
    });
    const reviews = await this.prisma.weeklyReview.updateMany({
      where: { userId, status: WeeklyReviewStatus.AWAITING_LIMIT },
      data: { status: WeeklyReviewStatus.COMPLETED, respondedAt: new Date() },
    });
    const pick = await this.dropBeneficiaryPick(userId);

    if (transfers.count || bills.count || reviews.count || pick) {
      this.logger.log(
        `user ${userId} moved to ${now}: expired ${transfers.count} transfer draft(s), ${bills.count} bill draft(s), ${reviews.count} limit wait(s)${pick ? ", a beneficiary pick" : ""}`,
      );
    }
  }

  private async dropBeneficiaryPick(userId: string): Promise<boolean> {
    const session = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    const context = session?.contextData;
    if (
      !session ||
      !context ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      !("beneficiaryPick" in context)
    ) {
      return false;
    }
    const { beneficiaryPick: _dropped, ...rest } = context;
    await this.prisma.conversationSession.update({
      where: { id: session.id },
      data: { contextData: rest as Prisma.InputJsonValue },
    });
    return true;
  }

  private async release(userId: string, holder: string): Promise<void> {
    try {
      await this.prisma.userTurnLease.updateMany({
        where: { userId, holder },
        data: { expiresAt: new Date(0) },
      });
    } catch (err) {
      // The lease lapses on its own; never let this hide the turn's own error.
      this.logger.warn(
        `user ${userId}: releasing the turn lease failed: ${String(err)}`,
      );
    }
  }
}
