import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsChangeType, SettingsChangeStatus } from '@prisma/client';

const MIN_DAYS = Number(process.env.SETTINGS_CHANGE_MIN_DAYS ?? 7);

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

  async reviewRequest(requestId: string, decision: 'APPROVED' | 'REJECTED', managerNotes?: string) {
    const request = await this.prisma.settingsChangeRequest.findUniqueOrThrow({
      where: { id: requestId },
    });

    if (new Date() < request.eligibleAt) {
      throw new BadRequestException(
        `Not eligible for review until ${request.eligibleAt.toISOString()} — the ${MIN_DAYS}-day minimum holds regardless of framing.`,
      );
    }

    return this.prisma.settingsChangeRequest.update({
      where: { id: requestId },
      data: {
        status: decision as SettingsChangeStatus,
        managerNotes,
        resolvedAt: new Date(),
      },
    });
  }

  // TODO: the actual Manager persona conversation (formal tone, quotes the
  // user's statedGoal/statedGoalSetAt from User back at them) lives in the
  // conversation-model layer and calls fileChangeRequest/reviewRequest —
  // it never bypasses the eligibleAt check above.
}
