import { Injectable, Logger } from "@nestjs/common";
import { PinChallenge, PinChallengePurpose, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PinService, OTP_LENGTH } from "../pin/pin.service";
import { EmailNotificationsService } from "../email/email-notifications.service";
import { ChannelMessenger, FormKind } from "../messaging/channel-messenger";
import { SensitiveFields } from "./whatsapp-message.service";

/**
 * What the caller should do once a PIN submission has been handled. Returning
 * an instruction instead of calling TransferConfirmationService directly
 * keeps the dependency one-way (TransferConfirmation -> PinGate) and makes
 * WhatsappRouterService the single composition point, rather than introducing
 * a forwardRef cycle between the two services.
 */
export type PinFlowOutcome =
  | { action: "none" }
  | { action: "execute_transfer"; transactionId: string }
  | { action: "execute_bill_payment"; billPaymentId: string }
  | { action: "pin_setup_complete" };

/**
 * The WhatsApp-facing half of PIN authentication: sending the entry/setup
 * Flows and handling what comes back.
 *
 * PIN entry is a WhatsApp Flow, never a chat message, for two reasons. The
 * obvious one is that a Flow renders a proper masked input. The load-bearing
 * one is that a chat message would be persisted verbatim in
 * WhatsappMessage.textBody before any handler ran. A Flow reply is persisted
 * too, but its sensitive fields are stripped at the persistence boundary and
 * handed here in memory instead (see sensitive-fields.util.ts).
 */
@Injectable()
export class PinGateService {
  private readonly logger = new Logger(PinGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pin: PinService,
    private readonly messenger: ChannelMessenger,
    private readonly emailNotifications: EmailNotificationsService,
  ) {}

  // =========================================================================
  // Outbound: asking for a PIN
  // =========================================================================

  /**
   * Sends the PIN-entry Flow for a transfer that has passed every other
   * guard. The challenge binds this specific transaction to the flowToken, so
   * the reply cannot be replayed against a different transfer.
   */
  async requestTransferPin(user: User, transactionId: string): Promise<void> {
    const challenge = await this.pin.createChallenge({
      userId: user.id,
      purpose: PinChallengePurpose.TRANSFER_AUTH,
      transactionId,
    });

    await this.sendPinFlow(user, {
      kind: "PIN_ENTRY",
      flowToken: challenge.flowToken,
      headerText: "Enter your PIN",
      bodyText: "Enter your 4-digit PIN to authorize this transfer.",
      ctaText: "Enter PIN",
    });
  }

  /** PIN-entry Flow for a bill/airtime purchase that passed confirm. */
  async requestBillPaymentPin(
    user: User,
    billPaymentId: string,
  ): Promise<void> {
    const challenge = await this.pin.createChallenge({
      userId: user.id,
      purpose: PinChallengePurpose.TRANSFER_AUTH,
      billPaymentId,
    });

    await this.sendPinFlow(user, {
      kind: "PIN_ENTRY",
      flowToken: challenge.flowToken,
      headerText: "Enter your PIN",
      bodyText: "Enter your 4-digit PIN to authorize this airtime purchase.",
      ctaText: "Enter PIN",
    });
  }

  /** Sends the first-time PIN setup Flow (enter + confirm). */
  async requestPinSetup(user: User): Promise<void> {
    const challenge = await this.pin.createChallenge({
      userId: user.id,
      purpose: PinChallengePurpose.SETUP,
    });

    await this.sendPinFlow(user, {
      kind: "PIN_SETUP",
      flowToken: challenge.flowToken,
      headerText: "Set your transfer PIN",
      bodyText:
        "Choose a 4-digit PIN. You'll enter it to approve every transfer, so pick something you'll remember but others can't guess.",
      ctaText: "Set PIN",
    });
  }

  /**
   * Starts a PIN reset: emails a one-time code to the address on file, then
   * sends the WhatsApp form that takes the code and the new PIN together.
   *
   * The email address is the second factor and the whole basis of this flow's
   * safety. It is the KYC address captured at account creation, and it is
   * deliberately NOT something the user can change from chat — otherwise
   * someone holding the phone could point the reset at their own inbox and
   * the factor would be worthless.
   *
   * Works while the PIN is locked. That is the point: lockout exists to stop
   * guessing, and someone who can read the account's email has proven more
   * than a guesser could. A successful reset clears the lockout.
   */
  async requestPinReset(user: User): Promise<void> {
    if (!user.pinHash) {
      // Nothing to reset — send them down the setup path instead of minting
      // a code for a PIN that doesn't exist.
      await this.messenger.sendText(
        user,
        "you don't have a pin yet, so there's nothing to reset. let's set one now.",
      );
      await this.requestPinSetup(user);
      return;
    }

    if (!user.email) {
      this.logger.warn(
        `User ${user.id} asked for a PIN reset with no email on file`,
      );
      await this.messenger.sendText(
        user,
        "i can't reset your pin because there's no email address on your account. that email is how i check it's really you, so i can't skip it. message us and we'll sort it out properly.",
      );
      return;
    }

    if (!(await this.pin.canRequestReset(user.id))) {
      await this.messenger.sendText(
        user,
        "you've asked for a few reset codes already. give it an hour, then try again. check your email in the meantime, the last code may still be valid.",
      );
      return;
    }

    const { challenge, otp } = await this.pin.createResetChallenge(user.id);

    // Unlike the other emails, this one is NOT best-effort: with no code
    // there is no reset, so a failure has to be said out loud rather than
    // leaving the user waiting on a form they can't complete.
    const sent = await this.emailNotifications.sendPinResetOtp({
      user,
      otp,
      challengeId: challenge.id,
      expiresInMinutes: 10,
    });
    if (!sent) {
      await this.messenger.sendText(
        user,
        "i couldn't send the reset code to your email just now. try again in a few minutes, and if it keeps failing, message us.",
      );
      return;
    }

    await this.messenger.sendText(
      user,
      `i've sent a ${OTP_LENGTH}-digit code to ${maskEmail(user.email)}. it expires in 10 minutes.\n\nopen the form below and enter that code along with your new pin.`,
    );
    await this.sendResetFlow(user, challenge.flowToken);
  }

  /** Sends the reset form for an existing challenge (initial send and retries). */
  private async sendResetFlow(user: User, flowToken: string): Promise<void> {
    await this.sendPinFlow(user, {
      kind: "PIN_RESET",
      flowToken,
      headerText: "Reset your PIN",
      bodyText:
        "Enter the code from your email, then choose a new 4-digit PIN.",
      ctaText: "Reset PIN",
    });
  }

  /**
   * A channel may be unable to show the form: on WhatsApp, a Flow must be
   * published in Meta's Business Manager before it has an id, so a fresh
   * environment legitimately has none (the adapter logs which). Tell the user
   * plainly, never crash. Matches OnboardingService.sendKycFlow.
   */
  private async sendPinFlow(
    user: User,
    params: {
      kind: Exclude<FormKind, "KYC">;
      flowToken: string;
      headerText: string;
      bodyText: string;
      ctaText: string;
    },
  ): Promise<void> {
    const shown = await this.messenger.requestForm(user, {
      kind: params.kind,
      token: params.flowToken,
      headerText: params.headerText,
      bodyText: params.bodyText,
      ctaText: params.ctaText,
    });
    if (!shown) {
      await this.messenger.sendText(
        user,
        "the pin form isn't set up on this environment yet, a developer needs to publish it first.",
      );
    }
  }

  // =========================================================================
  // Inbound: handling a PIN submission
  // =========================================================================

  /**
   * Handles a Flow reply carrying a PIN. `sensitive` holds the plaintext
   * values, in memory only — they are never present on the persisted
   * WhatsappMessage row.
   *
   * Returns an instruction rather than acting on the transfer itself; the
   * router executes it. Every rejection path returns `none`, so there is no
   * way to reach a transfer execution without a consumed, valid challenge
   * whose purpose is TRANSFER_AUTH.
   */
  async handlePinFlowReply(
    user: User,
    responseJson: Record<string, unknown>,
    sensitive: SensitiveFields,
  ): Promise<PinFlowOutcome> {
    const flowToken = String(responseJson.flow_token ?? "");
    if (!flowToken) {
      this.logger.warn(`PIN flow reply from user ${user.id} had no flow_token`);
      return { action: "none" };
    }

    const challenge = await this.pin.consumeChallenge(flowToken, user.id);
    if (!challenge) {
      // Unknown, expired, replayed, or another user's token — all already
      // logged in detail by consumeChallenge.
      await this.messenger.sendText(
        user,
        "that pin request has expired or was already used. start the transfer again and i'll ask fresh.",
      );
      return { action: "none" };
    }

    if (challenge.purpose === PinChallengePurpose.RESET) {
      await this.handleResetSubmission(user, challenge, sensitive);
      return { action: "none" };
    }

    if (challenge.purpose === PinChallengePurpose.SETUP) {
      const ok = await this.handleSetupSubmission(user, sensitive);
      return ok ? { action: "pin_setup_complete" } : { action: "none" };
    }

    if (challenge.billPaymentId) {
      return this.handleBillPaymentSubmission(
        user,
        challenge.billPaymentId,
        sensitive,
      );
    }

    return this.handleTransferSubmission(
      user,
      challenge.transactionId,
      sensitive,
    );
  }

  private async handleSetupSubmission(
    user: User,
    sensitive: SensitiveFields,
  ): Promise<boolean> {
    const pin = sensitive.pin ?? "";
    const confirm = sensitive.pin_confirm ?? "";

    const result = await this.pin.setPin(user.id, pin, confirm);
    if (!result.ok) {
      await this.messenger.sendText(user, result.reason);
      await this.requestPinSetup(user); // fresh challenge, fresh form
      return false;
    }

    await this.messenger.sendText(
      user,
      "your pin is set. you'll enter it to approve every transfer from now on. if you ever forget it, message me and we'll sort it out.",
    );
    return true;
  }

  /**
   * Verifies the emailed code, then applies the new PIN. Order matters: the
   * code is checked FIRST, so a wrong code never reveals anything about
   * whether the proposed PIN would have been acceptable.
   */
  private async handleResetSubmission(
    user: User,
    challenge: PinChallenge,
    sensitive: SensitiveFields,
  ): Promise<void> {
    const otp = sensitive.otp ?? "";
    const verdict = await this.pin.verifyResetOtp(challenge, otp);

    if (!verdict.ok) {
      if (verdict.exhausted) {
        await this.messenger.sendText(
          user,
          "that code was wrong too many times, so i've cancelled this reset. your pin hasn't changed. ask me to reset it again when you're ready and i'll send a fresh code.",
        );
        return;
      }

      await this.messenger.sendText(
        user,
        `that code isn't right. ${verdict.attemptsLeft} ${verdict.attemptsLeft === 1 ? "try" : "tries"} left. the code is in your email, and it's still the same one.`,
      );
      await this.sendResetFlow(user, verdict.retryChallenge.flowToken);
      return;
    }

    const result = await this.pin.setPin(
      user.id,
      sensitive.pin ?? "",
      sensitive.pin_confirm ?? "",
    );
    if (!result.ok) {
      // The code was right, so don't make them re-verify: issue a successor
      // challenge carrying the same verified code forward.
      await this.messenger.sendText(user, result.reason);
      const retry = await this.pin.createChallenge({
        userId: user.id,
        purpose: PinChallengePurpose.RESET,
        otpHash: challenge.otpHash ?? undefined,
        otpAttempts: challenge.otpAttempts,
        expiresAt: challenge.expiresAt,
      });
      await this.sendResetFlow(user, retry.flowToken);
      return;
    }

    // setPin clears pinFailedAttempts and pinLockedUntil, so a reset is also
    // the way out of a lockout.
    await this.messenger.sendText(
      user,
      "your pin has been reset. use the new one to approve your next transfer.",
    );
  }

  private async handleTransferSubmission(
    user: User,
    transactionId: string | null,
    sensitive: SensitiveFields,
  ): Promise<PinFlowOutcome> {
    if (!transactionId) {
      this.logger.error(
        `TRANSFER_AUTH challenge for user ${user.id} had no transactionId — refusing`,
      );
      return { action: "none" };
    }

    const result = await this.pin.verifyPin(user.id, sensitive.pin ?? "");
    if (!result.ok) {
      await this.messenger.sendText(user, result.reason);

      if (result.lockedUntil) {
        // Locked: abandon the transfer outright rather than leaving it
        // sitting in PENDING_PIN where a later unlock could silently resume
        // a transfer the user has long since moved on from.
        await this.cancelPendingTransfer(transactionId);
        return { action: "none" };
      }

      // Wrong but not locked — offer another attempt with a fresh challenge.
      await this.requestTransferPin(user, transactionId);
      return { action: "none" };
    }

    return { action: "execute_transfer", transactionId };
  }

  private async handleBillPaymentSubmission(
    user: User,
    billPaymentId: string,
    sensitive: SensitiveFields,
  ): Promise<PinFlowOutcome> {
    const result = await this.pin.verifyPin(user.id, sensitive.pin ?? "");
    if (!result.ok) {
      await this.messenger.sendText(user, result.reason);

      if (result.lockedUntil) {
        await this.cancelPendingBillPayment(billPaymentId);
        return { action: "none" };
      }

      await this.requestBillPaymentPin(user, billPaymentId);
      return { action: "none" };
    }

    return { action: "execute_bill_payment", billPaymentId };
  }

  private async cancelPendingTransfer(transactionId: string): Promise<void> {
    await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: "PENDING_PIN" },
      data: { status: "CANCELLED" },
    });
  }

  private async cancelPendingBillPayment(billPaymentId: string): Promise<void> {
    await this.prisma.billPayment.updateMany({
      where: { id: billPaymentId, status: "PENDING_PIN" },
      data: { status: "CANCELLED" },
    });
  }

  /** True if the user is currently locked out of PIN entry. */
  isLocked(user: User, now: Date = new Date()): boolean {
    return this.pin.isLocked(user, now);
  }

  /** Tells the user how long their PIN lockout has left to run. */
  async notifyLocked(user: User): Promise<void> {
    return this.sendLockedMessage(user);
  }

  private async sendLockedMessage(user: User): Promise<void> {
    const until = user.pinLockedUntil;
    const minutes = until
      ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000))
      : 0;
    await this.messenger.sendText(
      user,
      `your pin is locked after too many wrong attempts. try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * Shows enough of the address to confirm which inbox to check, without
 * printing it in full into a chat that someone holding the phone can read.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "your email";
  const shown = local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}
