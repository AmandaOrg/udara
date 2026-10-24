import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  SettingsChangeRequest,
  SettingsChangeType,
  SettingsChangeStatus,
} from "@prisma/client";

const MIN_DAYS = Number(process.env.SETTINGS_CHANGE_MIN_DAYS ?? 7);

/** Not yet decided: the only statuses a decision or a withdrawal can claim. */
export const OPEN_REQUEST_STATUSES: SettingsChangeStatus[] = [
  SettingsChangeStatus.PENDING,
  SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
];

export type WithdrawResult =
  | { ok: true; request: SettingsChangeRequest }
  | { ok: false; reason: "not_found" | "already_decided" };

/**
 * The hard gate is deliberately dumb (a timestamp comparison) — the tone/
 * persona work for "the managers" sits in the conversation layer on top of
 * this, but the gate itself must hold regardless of how the request is
 * framed (PRD section 7).
 */
@Injectable()
export class ManagerService {
  constructor(private readonly prisma: PrismaService) {}

  async fileChangeRequest(params: {
    userId: string;
    type: SettingsChangeType;
    requestedChange: string;
    reason?: string;
  }) {
    const requestedAt = new Date();
    const eligibleAt = new Date(requestedAt);
    eligibleAt.setDate(eligibleAt.getDate() + MIN_DAYS);

    return this.prisma.settingsChangeRequest.create({
      data: {
        userId: params.userId,
        type: params.type,
        requestedChange: params.requestedChange,
        reason: params.reason,
        requestedAt,
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      },
    });
  }

  async reviewRequest(
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    managerNotes?: string,
  ) {
    const request = await this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    // Approving a closure here would mark it done while nothing was closed.
    // Only AccountClosureService decides those (ADR-0003).
    if (request.type === SettingsChangeType.ACCOUNT_DELETION) {
      throw new BadRequestException(
        `Request ${requestId} asks to close the account. Decide it with npm run account:close or account:decline, never here.`,
      );
    }

    if (new Date() < request.eligibleAt) {
      throw new BadRequestException(
        `Not eligible for review until ${request.eligibleAt.toISOString()} — the ${MIN_DAYS}-day minimum holds regardless of framing.`,
      );
    }

    // Claimed from an undecided status. A plain update let a REJECTED request
    // be flipped to APPROVED later, and let a second review silently overwrite
    // the first — on the one decision that can lift a user's spending
    // restrictions entirely.
    const { count } = await this.prisma.settingsChangeRequest.updateMany({
      where: {
        id: requestId,
        status: {
          in: [
            SettingsChangeStatus.PENDING,
            SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
          ],
        },
      },
      data: {
        status: decision as SettingsChangeStatus,
        managerNotes,
        resolvedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new BadRequestException(
        `Request ${requestId} has already been decided (${request.status}). Decisions are final.`,
      );
    }

    return this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
  }

  /**
   * The user takes a request back before it is decided. Withdrawing only ever
   * keeps things as they are, so unlike a decision it is not gated on
   * eligibleAt. Claimed from an open status, so it cannot undo a decision that
   * landed first, and scoped to the user, so nobody withdraws someone else's.
   */
  async withdrawRequest(
    userId: string,
    requestId: string,
    now: Date = new Date(),
  ): Promise<WithdrawResult> {
    const { count } = await this.prisma.settingsChangeRequest.updateMany({
      where: {
        id: requestId,
        userId,
        status: { in: OPEN_REQUEST_STATUSES },
      },
      data: { status: SettingsChangeStatus.WITHDRAWN, resolvedAt: now },
    });
    const request = await this.prisma.settingsChangeRequest.findFirst({
      where: { id: requestId, userId },
    });
    if (!request) return { ok: false, reason: "not_found" };
    if (count === 0) return { ok: false, reason: "already_decided" };
    return { ok: true, request };
  }

  // TODO: the actual Manager persona conversation (formal tone, quotes the
  // user's statedGoal/statedGoalSetAt from User back at them) lives in the
  // conversation-model layer and calls fileChangeRequest/reviewRequest —
  // it never bypasses the eligibleAt check above.
}
