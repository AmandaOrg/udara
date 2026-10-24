import { Injectable } from "@nestjs/common";
import {
  Device,
  DevicePlatform,
  LoginStepUpMethod,
  Prisma,
  User,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PinService } from "../pin/pin.service";
import { ChannelMessenger } from "../messaging/channel-messenger";
import { EmailNotificationsService } from "../email/email-notifications.service";
import { OtpService } from "./otp.service";
import { SessionService, TokenPair } from "./session.service";
import { newToken, tokenDigest } from "./secret-hash.util";
import {
  LOGIN_APPROVE_PREFIX,
  LOGIN_DENY_PREFIX,
} from "./login-approval.service";

const LOGIN_CHALLENGE_TTL_MS = 10 * 60_000;
/**
 * Sign-in approvals and new-device warnings go to WhatsApp and nowhere else,
 * whatever channel the user was last on (S14). Only the WhatsApp router
 * answers the approval buttons, and a warning delivered to the phone that is
 * signing in warns nobody.
 */
const ON_WHATSAPP = { delivery: "transactional", channel: "whatsapp" } as const;

export type Authenticated = {
  status: "authenticated";
  tokens: TokenPair;
  userId: string;
  isNewUser: boolean;
};

export type SignInOutcome =
  | Authenticated
  | {
      status: "step_up_required";
      method: "pin" | "whatsapp";
      challengeToken: string;
      expiresAt: Date;
    }
  | {
      status: "invalid_code";
      reason: "invalid" | "expired" | "exhausted";
      attemptsLeft?: number;
    };

export type StepUpOutcome =
  | Authenticated
  | { status: "pending" }
  | { status: "wrong_pin"; message: string }
  | { status: "locked"; lockedUntil: Date }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "invalid_challenge" };

/**
 * Signing in to the mobile app.
 *
 * An SMS code proves control of the SIM, and a SIM can be swapped or a number
 * recycled. So when the number already belongs to an account that has
 * something worth protecting, the code alone is not enough on a new device
 * (ADR-0002):
 *
 * - the account has a transfer PIN: the PIN too, under the same lockout as a
 *   transfer;
 * - no PIN but a WhatsApp conversation: a "was this you?" tap there;
 * - neither (a new user, or one who has never set a PIN or used WhatsApp): the
 *   code alone. There is no second factor to ask for yet, which is why the app
 *   onboarding sets the PIN before any funding details are shown.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly pin: PinService,
    private readonly messenger: ChannelMessenger,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  async signIn(
    input: {
      phoneNumber: string;
      code: string;
      platform: DevicePlatform;
      deviceName?: string | null;
    },
    now: Date = new Date(),
  ): Promise<SignInOutcome> {
    const verdict = await this.otp.verify(input.phoneNumber, input.code, now);
    if (!verdict.ok) {
      return {
        status: "invalid_code",
        reason: verdict.reason,
        ...("attemptsLeft" in verdict && verdict.attemptsLeft !== undefined
          ? { attemptsLeft: verdict.attemptsLeft }
          : {}),
      };
    }

    // Created only now, after the code proved the number: a stranger typing
    // someone's number into the app leaves nothing behind.
    const { user, isNewUser } = await this.findOrCreateUser(input.phoneNumber);
    const device = await this.prisma.device.create({
      data: {
        userId: user.id,
        platform: input.platform,
        name: input.deviceName ?? null,
      },
    });

    const method = user.pinHash
      ? LoginStepUpMethod.PIN
      : user.whatsappNumber
        ? LoginStepUpMethod.WHATSAPP
        : null;
    if (!method) {
      return this.trustAndIssue(user, device, {
        isNewUser,
        // Nothing to warn a brand-new user about; an existing one hears by email.
        notifyWhatsapp: false,
        notifyEmail: !isNewUser,
        now,
      });
    }

    const challengeToken = newToken("udr_lc");
    const expiresAt = new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS);
    const challenge = await this.prisma.loginChallenge.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        method,
        tokenHash: tokenDigest(challengeToken),
        expiresAt,
      },
    });

    if (method === LoginStepUpMethod.WHATSAPP) {
      await this.messenger.sendButtons(
        user,
        `someone is signing in to udara on ${describeDevice(device)}. was this you?`,
        [
          {
            id: `${LOGIN_APPROVE_PREFIX}${challenge.id}`,
            title: "Yes, it's me",
          },
          { id: `${LOGIN_DENY_PREFIX}${challenge.id}`, title: "No, block it" },
        ],
        ON_WHATSAPP,
      );
    }

    return {
      status: "step_up_required",
      method: method === LoginStepUpMethod.PIN ? "pin" : "whatsapp",
      challengeToken,
      expiresAt,
    };
  }

  async stepUpWithPin(
    challengeToken: string,
    pin: string,
    now: Date = new Date(),
  ): Promise<StepUpOutcome> {
    const challenge = await this.openChallenge(
      challengeToken,
      LoginStepUpMethod.PIN,
    );
    if (!challenge) return { status: "invalid_challenge" };
    if (challenge.expiresAt <= now) return { status: "expired" };

    // The same counter and lockout as a transfer PIN: one guess budget per
    // account, however many doors it is tried at.
    const result = await this.pin.verifyPin(challenge.userId, pin, now);
    if (!result.ok) {
      return result.lockedUntil
        ? { status: "locked", lockedUntil: result.lockedUntil }
        : { status: "wrong_pin", message: result.reason };
    }

    if (!(await this.consume(challenge.id, now))) {
      return { status: "invalid_challenge" };
    }
    return this.trustAndIssue(challenge.user, challenge.device, {
      isNewUser: false,
      notifyWhatsapp: true,
      notifyEmail: true,
      now,
    });
  }

  async pollWhatsappApproval(
    challengeToken: string,
    now: Date = new Date(),
  ): Promise<StepUpOutcome> {
    const challenge = await this.openChallenge(
      challengeToken,
      LoginStepUpMethod.WHATSAPP,
    );
    if (!challenge) return { status: "invalid_challenge" };
    if (challenge.rejectedAt) return { status: "denied" };
    if (!challenge.approvedAt) {
      return challenge.expiresAt <= now
        ? { status: "expired" }
        : { status: "pending" };
    }

    if (!(await this.consume(challenge.id, now))) {
      return { status: "invalid_challenge" };
    }
    return this.trustAndIssue(challenge.user, challenge.device, {
      isNewUser: false,
      // They just approved it on WhatsApp; email is the other channel.
      notifyWhatsapp: false,
      notifyEmail: true,
      now,
    });
  }

  private async openChallenge(token: string, method: LoginStepUpMethod) {
    const challenge = await this.prisma.loginChallenge.findUnique({
      where: { tokenHash: tokenDigest(token) },
      include: { user: true, device: true },
    });
    if (
      !challenge ||
      challenge.method !== method ||
      challenge.consumedAt ||
      challenge.device.revokedAt
    ) {
      return null;
    }
    return challenge;
  }

  /** Single use: of two parallel completions, one gets tokens. */
  private async consume(challengeId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.loginChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  private async trustAndIssue(
    user: User,
    device: Device,
    options: {
      isNewUser: boolean;
      notifyWhatsapp: boolean;
      notifyEmail: boolean;
      now: Date;
    },
  ): Promise<Authenticated> {
    await this.prisma.device.update({
      where: { id: device.id },
      data: { trustedAt: options.now },
    });

    if (options.notifyWhatsapp && user.whatsappNumber) {
      await this.messenger.sendText(
        user,
        `heads up: your udara account was just opened in the app on ${describeDevice(device)}. if that wasn't you, tell me here right away and don't share any code you're sent.`,
        ON_WHATSAPP,
      );
    }
    if (options.notifyEmail) {
      await this.emailNotifications.sendNewDeviceLogin({
        user,
        deviceId: device.id,
        deviceName: device.name,
        platform: platformLabel(device.platform),
        at: options.now,
      });
    }

    const tokens = await this.sessions.issue(
      user.id,
      device.id,
      undefined,
      options.now,
    );
    return {
      status: "authenticated",
      tokens,
      userId: user.id,
      isNewUser: options.isNewUser,
    };
  }

  private async findOrCreateUser(
    phoneNumber: string,
  ): Promise<{ user: User; isNewUser: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });
    if (existing) return { user: existing, isNewUser: false };
    try {
      const user = await this.prisma.user.create({ data: { phoneNumber } });
      return { user, isNewUser: true };
    } catch (err) {
      // A first WhatsApp message from the same number created it in between.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const user = await this.prisma.user.findUniqueOrThrow({
          where: { phoneNumber },
        });
        return { user, isNewUser: false };
      }
      throw err;
    }
  }
}

function platformLabel(platform: DevicePlatform): string {
  return platform === DevicePlatform.IOS ? "iPhone" : "Android";
}

function describeDevice(device: Pick<Device, "name" | "platform">): string {
  const kind = platformLabel(device.platform);
  return device.name ? `${device.name} (${kind})` : `a new ${kind} phone`;
}
