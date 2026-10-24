import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import { isPreAccountStage } from "../onboarding/onboarding.service";
import {
  Prisma,
  User,
  WhatsappMessage,
  WhatsappMessageType,
} from "@prisma/client";
import { ChannelMessenger } from "../messaging/channel-messenger";
import {
  LOGIN_APPROVE_PREFIX,
  LOGIN_DENY_PREFIX,
  LoginApprovalService,
} from "../app-auth/login-approval.service";
import {
  SensitiveFields,
  WhatsappMessageService,
} from "./whatsapp-message.service";
import { DeepgramService } from "./deepgram.service";
import { InboundRateLimitService } from "./inbound-rate-limit.service";
import { OrchestratorTurnOptions } from "../orchestrator/orchestrator.types";
import { ConversationRouterService } from "../conversation/conversation-router.service";
import { TurnService } from "../conversation/turn.service";
import { maskPhone } from "../app-auth/sms.service";

const AUDIO_TYPE_INSTEAD =
  "I can't listen to voice notes yet, could you type that instead?";
const AUDIO_COULDNT_HEAR = "I couldn't hear that clearly, could you type it?";
const IMAGE_COULDNT_OPEN =
  "I couldn't open that photo, could you type what you meant?";
const VISION_MAX_BYTES = 16 * 1024 * 1024;

/**
 * WhatsApp's half of inbound routing: who sent it, whether they are over the
 * rate limit, and turning a webhook message (text, voice note, photo, button,
 * Flow) into a conversation event. What Udara then does is
 * ConversationRouterService's, shared with the app.
 */
@Injectable()
export class WhatsappRouterService {
  private readonly logger = new Logger(WhatsappRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly conversation: ConversationRouterService,
    private readonly turns: TurnService,
    private readonly deepgram: DeepgramService,
    private readonly inboundMessages: WhatsappMessageService,
    private readonly rateLimit: InboundRateLimitService,
    private readonly messenger: ChannelMessenger,
    private readonly loginApproval: LoginApprovalService,
  ) {}

  async route(
    message: WhatsappMessage,
    sensitive: SensitiveFields = {},
  ): Promise<void> {
    const user = await this.findOrCreateUser(message.fromNumber);
    // Must precede the rate check, which counts this user's inbound rows.
    await this.inboundMessages.attachUser(message.id, user.id);

    // Before any handler: past this point a message can cost an LLM call, a
    // media download and a transcription, and nothing else bounds that.
    const rate = await this.rateLimit.check(user.id);
    if (rate.limited) {
      if (rate.justCrossed) {
        await this.messenger.sendText(
          user,
          "that's a lot of messages at once. give me a few minutes and try again.",
        );
      }
      return;
    }

    // Not a conversation turn, so outside the lease and the channel-switch
    // expiry: approving an app sign-in must not close a wizard the user has
    // open in the app. Answered even mid-onboarding.
    if (await this.handledLoginApproval(user, message)) return;

    await this.turns.run(user.id, "whatsapp", (current) =>
      this.dispatch(current, message, sensitive),
    );
  }

  private async dispatch(
    user: User,
    message: WhatsappMessage,
    sensitive: SensitiveFields,
  ): Promise<void> {
    switch (message.type) {
      case WhatsappMessageType.AUDIO:
        return this.handleAudio(user, message);
      case WhatsappMessageType.BUTTON_REPLY:
      case WhatsappMessageType.LIST_REPLY:
        return this.conversation.handleChoice(
          user,
          message.buttonPayload ?? "",
        );
      case WhatsappMessageType.FLOW_REPLY:
        return this.handleFlowReply(user, message, sensitive);
      case WhatsappMessageType.TEXT:
        return this.conversation.handleText(user, message.textBody ?? "");
      case WhatsappMessageType.IMAGE:
        return this.handleImage(user, message);
      case WhatsappMessageType.DOCUMENT:
      case WhatsappMessageType.LOCATION:
        return this.handleUnsupportedMedia(user);
      case WhatsappMessageType.UNKNOWN:
      default:
        // The user id, not the number: a phone number in a log line is
        // personal data in a sink nobody erases (ADR-0003).
        this.logger.warn(
          `Unhandled/unrecognized message type ${message.type} from user ${user.id}`,
        );
        await this.messenger.sendText(
          user,
          "Sorry, I couldn't understand that message.",
        );
    }
  }

  private async handledLoginApproval(
    user: User,
    message: WhatsappMessage,
  ): Promise<boolean> {
    if (
      message.type !== WhatsappMessageType.BUTTON_REPLY &&
      message.type !== WhatsappMessageType.LIST_REPLY
    ) {
      return false;
    }
    const payload = message.buttonPayload ?? "";
    if (payload.startsWith(LOGIN_APPROVE_PREFIX)) {
      await this.loginApproval.decide(
        user,
        payload.slice(LOGIN_APPROVE_PREFIX.length),
        true,
      );
      return true;
    }
    if (payload.startsWith(LOGIN_DENY_PREFIX)) {
      await this.loginApproval.decide(
        user,
        payload.slice(LOGIN_DENY_PREFIX.length),
        false,
      );
      return true;
    }
    return false;
  }

  /**
   * The sender's User, creating or linking one as needed.
   *
   * Meta's sender id is already the canonical phone number (see
   * common/phone.util.ts), so a number that signed up in the app and now
   * messages on WhatsApp for the first time is found by phoneNumber and linked
   * rather than given a second account with a second set of limits.
   */
  private async findOrCreateUser(whatsappNumber: string): Promise<User> {
    const now = new Date();
    const onWhatsapp = await this.prisma.user.findUnique({
      where: { whatsappNumber },
    });
    if (onWhatsapp) {
      return this.prisma.user.update({
        where: { id: onWhatsapp.id },
        data: { lastInboundMessageAt: now },
      });
    }

    const linked = await this.linkWhatsapp(whatsappNumber, now);
    if (linked) return linked;

    try {
      return await this.prisma.user.create({
        data: {
          phoneNumber: whatsappNumber,
          whatsappNumber,
          lastInboundMessageAt: now,
        },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      ) {
        throw err;
      }
      // Lost a race: a redelivered webhook for this number, or an app sign-up
      // with it, created the row between the lookups above and this insert.
      const winner =
        (await this.prisma.user.findUnique({ where: { whatsappNumber } })) ??
        (await this.linkWhatsapp(whatsappNumber, now));
      if (winner) return winner;
      throw new Error(
        `findOrCreateUser: phone number ${maskPhone(whatsappNumber)} is taken by a user already linked to a different WhatsApp number`,
      );
    }
  }

  /**
   * Links this WhatsApp number to the account holding the same phone number.
   * Conditional on that account having no WhatsApp number yet, so an existing
   * link is never overwritten, and two racing first messages link it once.
   */
  private async linkWhatsapp(
    whatsappNumber: string,
    now: Date,
  ): Promise<User | null> {
    const { count } = await this.prisma.user.updateMany({
      where: { phoneNumber: whatsappNumber, whatsappNumber: null },
      data: { whatsappNumber, lastInboundMessageAt: now },
    });
    if (count === 0) return null;
    return this.prisma.user.findUnique({ where: { whatsappNumber } });
  }

  private async handleAudio(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    if (!this.deepgram.isConfigured()) {
      this.logger.warn(
        "Voice note ignored: DEEPGRAM_API_KEY is not set on this process",
      );
      await this.messenger.sendText(user, AUDIO_TYPE_INSTEAD);
      return;
    }
    const mediaId = message.mediaId ?? "";
    if (!mediaId) {
      await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
      return;
    }
    try {
      const { buffer, mimeType } = await this.whatsapp.downloadMedia(mediaId);
      const heard = await this.deepgram.transcribe(buffer, mimeType);
      if (!heard.ok || !heard.text) {
        await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
        return;
      }
      await this.inboundMessages.updateTextBody(message.id, heard.text);
      await this.conversation.handleText(user, heard.text);
    } catch (err) {
      this.logger.warn(`Audio download/STT failed: ${String(err)}`);
      await this.messenger.sendText(user, AUDIO_COULDNT_HEAR);
    }
  }

  private async handleImage(
    user: User,
    message: WhatsappMessage,
  ): Promise<void> {
    const caption = (message.textBody ?? "").trim();
    if (isPreAccountStage(user.onboardingStage)) {
      // No download before there is an account: onboarding only reads text.
      await this.conversation.handleText(
        user,
        caption || "(user sent a photo)",
      );
      return;
    }
    const mediaId = message.mediaId ?? "";
    if (!mediaId) {
      await this.messenger.sendText(user, IMAGE_COULDNT_OPEN);
      return;
    }
    try {
      const { buffer, mimeType } = await this.whatsapp.downloadMedia(mediaId);
      const syntheticText = caption.length === 0;
      const text = caption || "(user sent a photo)";
      let image: OrchestratorTurnOptions["image"];
      if (buffer.length > 0 && buffer.length <= VISION_MAX_BYTES) {
        image = {
          mimeType: mimeType || "image/jpeg",
          data: buffer.toString("base64"),
        };
      }
      await this.conversation.handleText(user, text, { image, syntheticText });
    } catch (err) {
      this.logger.warn(`Image download failed: ${String(err)}`);
      await this.messenger.sendText(user, IMAGE_COULDNT_OPEN);
    }
  }

  /** A WhatsApp Flow: the PIN forms carry a PIN or code, the KYC form does not. */
  private async handleFlowReply(
    user: User,
    message: WhatsappMessage,
    sensitive: SensitiveFields,
  ): Promise<void> {
    const responseJson =
      (message.flowResponseJson as Record<string, unknown> | null) ?? {};

    if (
      sensitive.pin !== undefined ||
      sensitive.pin_confirm !== undefined ||
      sensitive.otp !== undefined
    ) {
      await this.conversation.handlePinForm(user, responseJson, sensitive);
      return;
    }
    await this.conversation.handleKycForm(user, responseJson, sensitive);
  }

  private async handleUnsupportedMedia(user: User): Promise<void> {
    await this.messenger.sendText(
      user,
      "I can't do anything with that kind of message yet, could you send it as text?",
    );
  }
}
