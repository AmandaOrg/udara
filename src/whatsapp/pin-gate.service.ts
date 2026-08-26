import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinChallengePurpose, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PinService } from "../pin/pin.service";
import { WhatsappService } from "./whatsapp.service";
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
    private readonly config: ConfigService,
    private readonly pin: PinService,
    private readonly whatsapp: WhatsappService,
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
      flowId: this.config.get<string>("WHATSAPP_PIN_ENTRY_FLOW_ID"),
      flowToken: challenge.flowToken,
      screenId: "PIN_ENTRY",
      headerText: "Enter your PIN",
      bodyText: "Enter your 4-digit PIN to authorize this transfer.",
      ctaText: "Enter PIN",
      envVar: "WHATSAPP_PIN_ENTRY_FLOW_ID",
    });
  }

  /** Sends the first-time PIN setup Flow (enter + confirm). */
  async requestPinSetup(user: User): Promise<void> {
    const challenge = await this.pin.createChallenge({
      userId: user.id,
      purpose: PinChallengePurpose.SETUP,
    });

    await this.sendPinFlow(user, {
      flowId: this.config.get<string>("WHATSAPP_PIN_SETUP_FLOW_ID"),
      flowToken: challenge.flowToken,
      screenId: "PIN_SETUP",
      headerText: "Set your transfer PIN",
      bodyText:
        "Choose a 4-digit PIN. You'll enter it to approve every transfer, so pick something you'll remember but others can't guess.",
      ctaText: "Set PIN",
      envVar: "WHATSAPP_PIN_SETUP_FLOW_ID",
    });
  }

  /**
   * Unset flow id is a dev-mode escape hatch, matching
   * OnboardingService.sendKycFlow exactly: a Flow must be created and
   * published in Meta's Business Manager before it has an id, so a fresh
   * environment legitimately has none. Warn loudly, tell the user plainly,
   * never crash.
   */
  private async sendPinFlow(
    user: User,
    params: {
      flowId: string | undefined;
      flowToken: string;
      screenId: string;
      headerText: string;
      bodyText: string;
      ctaText: string;
      envVar: string;
    },
  ): Promise<void> {
    if (!params.flowId) {
      this.logger.warn(
        `${params.envVar} is not set — cannot send the PIN form. See docs/whatsapp-flows/.`,
      );
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "the pin form isn't set up on this environment yet, a developer needs to publish it first.",
        user.id,
      );
      return;
    }

    await this.whatsapp.sendFlow({
      to: user.whatsappNumber,
      flowId: params.flowId,
      flowToken: params.flowToken,
      screenId: params.screenId,
      headerText: params.headerText,
      bodyText: params.bodyText,
      ctaText: params.ctaText,
      userId: user.id,
    });
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
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that pin request has expired or was already used. start the transfer again and i'll ask fresh.",
        user.id,
      );
      return { action: "none" };
    }

    if (challenge.purpose === PinChallengePurpose.SETUP) {
      const ok = await this.handleSetupSubmission(user, sensitive);
      return ok ? { action: "pin_setup_complete" } : { action: "none" };
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
      await this.whatsapp.sendText(user.whatsappNumber, result.reason, user.id);
      await this.requestPinSetup(user); // fresh challenge, fresh form
      return false;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      "your pin is set. you'll enter it to approve every transfer from now on. if you ever forget it, message me and we'll sort it out.",
      user.id,
    );
    return true;
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
      await this.whatsapp.sendText(user.whatsappNumber, result.reason, user.id);

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

  private async cancelPendingTransfer(transactionId: string): Promise<void> {
    await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: "PENDING_PIN" },
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
    await this.whatsapp.sendText(
      user.whatsappNumber,
      `your pin is locked after too many wrong attempts. try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      user.id,
    );
  }
}
