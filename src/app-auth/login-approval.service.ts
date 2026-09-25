import { Injectable } from "@nestjs/common";
import { LoginStepUpMethod } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  ChannelMessenger,
  MessageRecipient,
} from "../messaging/channel-messenger";

export const LOGIN_APPROVE_PREFIX = "login_approve:";
export const LOGIN_DENY_PREFIX = "login_deny:";

/**
 * The WhatsApp half of a sign-in step-up: the user's answer to "someone is
 * signing in on a new phone, was this you?". The app polls LoginService for
 * the outcome.
 */
@Injectable()
export class LoginApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messenger: ChannelMessenger,
  ) {}

  /**
   * Records the answer, scoped to the user who tapped it and only while the
   * request is still open: a stale button, a second tap, or a button naming
   * someone else's sign-in changes nothing.
   */
  async decide(
    user: MessageRecipient,
    challengeId: string,
    approve: boolean,
    now: Date = new Date(),
  ): Promise<void> {
    const { count } = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challengeId,
        userId: user.id,
        method: LoginStepUpMethod.WHATSAPP,
        approvedAt: null,
        rejectedAt: null,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: approve ? { approvedAt: now } : { rejectedAt: now },
    });
    if (count === 0) {
      await this.messenger.sendText(
        user,
        "that sign-in request has expired or was already answered.",
      );
      return;
    }

    if (approve) {
      await this.messenger.sendText(
        user,
        "done. head back to the app, you're signed in.",
      );
      return;
    }

    // Refused: the device never gets tokens, and cannot be approved later.
    const challenge = await this.prisma.loginChallenge.findUnique({
      where: { id: challengeId },
    });
    if (challenge) {
      await this.prisma.device.update({
        where: { id: challenge.deviceId },
        data: { revokedAt: now },
      });
    }
    await this.messenger.sendText(
      user,
      "blocked, nobody got in. if that wasn't you trying to sign in, someone has been getting your sms codes. don't share any code you're sent, and tell me here if anything looks off.",
    );
  }
}
