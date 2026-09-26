import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { Channel, currentChannelContext } from "./channel-context";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";
import { AppChannelAdapter } from "./app-channel.adapter";

/** Who a message is for. Everything a channel needs to address them. */
export type MessageRecipient = Pick<User, "id" | "whatsappNumber">;

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListOption {
  id: string;
  title: string;
  description?: string;
}

/**
 * A structured form for input that must never travel as chat text (KYC and
 * PIN). Each channel renders it natively: a WhatsApp Flow today, a native
 * screen in the app. `token` is the single-use id the submission must carry
 * back.
 */
export type FormKind = "KYC" | "PIN_SETUP" | "PIN_ENTRY" | "PIN_RESET";

export interface FormRequest {
  kind: FormKind;
  token: string;
  headerText: string;
  bodyText: string;
  ctaText: string;
}

/**
 * Why a message is being sent, which decides where it goes when no inbound
 * event is being handled.
 *
 * - `reply`: answering the user. Always has a channel context; one without is
 *   a wiring bug and is reported.
 * - `transactional`: the outcome of money the user moved (a transfer result, a
 *   credit landing).
 * - `proactive`: Udara starting a conversation (nudges, the weekly review, the
 *   managers' reply).
 *
 * Outside a context every class currently goes to WhatsApp when the user has
 * it, and to the app when they do not. The distinction is recorded at the call
 * sites that know it, for the P5 delivery policy that will need it.
 */
export type DeliveryClass = "reply" | "transactional" | "proactive";

export interface SendOptions {
  delivery?: DeliveryClass;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  sendText(to: MessageRecipient, body: string): Promise<void>;
  sendButtons(
    to: MessageRecipient,
    body: string,
    buttons: ReplyButton[],
  ): Promise<void>;
  sendList(
    to: MessageRecipient,
    body: string,
    buttonLabel: string,
    rows: ListOption[],
  ): Promise<void>;
  /** Text the model wrote, split into bubbles on blank lines. */
  sendChunked(to: MessageRecipient, text: string): Promise<void>;
  /** False when this channel cannot show that form in this environment. */
  requestForm(to: MessageRecipient, form: FormRequest): Promise<boolean>;
  sendTemplate(
    to: MessageRecipient,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<void>;
}

/**
 * The only way domain code sends a user anything.
 *
 * Domain services decide what to say; this decides which channel says it. That
 * split is what lets the same onboarding, wizards, confirmations and PIN gate
 * serve both WhatsApp and the mobile app without either knowing about the
 * other.
 */
@Injectable()
export class ChannelMessenger {
  private readonly logger = new Logger(ChannelMessenger.name);

  constructor(
    private readonly whatsapp: WhatsappChannelAdapter,
    private readonly app: AppChannelAdapter,
  ) {}

  async sendText(
    to: MessageRecipient,
    body: string,
    options?: SendOptions,
  ): Promise<void> {
    return await this.adapterFor("sendText", to, options).sendText(to, body);
  }

  async sendButtons(
    to: MessageRecipient,
    body: string,
    buttons: ReplyButton[],
    options?: SendOptions,
  ): Promise<void> {
    return await this.adapterFor("sendButtons", to, options).sendButtons(
      to,
      body,
      buttons,
    );
  }

  async sendList(
    to: MessageRecipient,
    body: string,
    buttonLabel: string,
    rows: ListOption[],
    options?: SendOptions,
  ): Promise<void> {
    return await this.adapterFor("sendList", to, options).sendList(
      to,
      body,
      buttonLabel,
      rows,
    );
  }

  async sendChunked(
    to: MessageRecipient,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    return await this.adapterFor("sendChunked", to, options).sendChunked(
      to,
      text,
    );
  }

  async requestForm(
    to: MessageRecipient,
    form: FormRequest,
    options?: SendOptions,
  ): Promise<boolean> {
    return await this.adapterFor("requestForm", to, options).requestForm(
      to,
      form,
    );
  }

  async sendTemplate(
    to: MessageRecipient,
    templateName: string,
    languageCode: string,
    components?: unknown[],
    options?: SendOptions,
  ): Promise<void> {
    return await this.adapterFor("sendTemplate", to, options).sendTemplate(
      to,
      templateName,
      languageCode,
      components,
    );
  }

  private adapterFor(
    method: string,
    to: MessageRecipient,
    options?: SendOptions,
  ): ChannelAdapter {
    const context = currentChannelContext();
    if (context) return this.adapter(context.channel);

    if ((options?.delivery ?? "reply") === "reply") {
      this.reportMissingContext(method);
    }
    // Delivery policy for sends outside any inbound event, until P5 replaces
    // it: WhatsApp for anyone who has it, which is every user who existed
    // before the app, and the app for someone who has only ever used the app,
    // who would otherwise get nothing at all.
    return to.whatsappNumber ? this.whatsapp : this.app;
  }

  private adapter(channel: Channel): ChannelAdapter {
    return channel === "app" ? this.app : this.whatsapp;
  }

  /**
   * A reply with nobody to reply to means an entry point forgot to open a
   * channel context, or a proactive send was not labelled as one. Either way
   * the message still goes out, but it would go to the wrong channel for an
   * app user, so it is logged rather than swallowed.
   */
  protected reportMissingContext(method: string): void {
    this.logger.warn(
      `${method} sent as a reply outside any channel context — routed by delivery policy. Open a context at the entry point, or mark the send as proactive/transactional.`,
    );
  }
}
