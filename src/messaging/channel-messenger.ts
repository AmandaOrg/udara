import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { Channel, currentChannelContext } from "./channel-context";
import { WhatsappChannelAdapter } from "./whatsapp-channel.adapter";
import { AppChannelAdapter } from "./app-channel.adapter";
import { DeliveryPlan, DeliveryPolicyService } from "./delivery-policy";
import { PushService } from "./push.service";

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
 * event is being handled (see delivery-policy.ts).
 *
 * - `reply`: answering the user. Always has a channel context; one without is
 *   a wiring bug and is reported.
 * - `transactional`: the outcome of money the user moved (a transfer result, a
 *   credit landing).
 * - `proactive`: Udara starting a conversation (nudges, the weekly review, the
 *   managers' reply).
 */
export type DeliveryClass = "reply" | "transactional" | "proactive";

export interface SendOptions {
  delivery?: DeliveryClass;
  /** The channel a payment was quoted on, so its result goes back there. */
  origin?: Channel;
  /**
   * Send on exactly this channel, whatever the context or the policy would
   * choose. For messages whose meaning depends on where they land: a sign-in
   * approval only WhatsApp can answer, a new-device warning that must reach a
   * channel other than the new phone.
   */
  channel?: Channel;
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

const REPLY_PLAN: DeliveryPlan = {
  channel: "whatsapp",
  mirrorToApp: false,
  push: false,
};

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
    private readonly policy: DeliveryPolicyService,
    private readonly push: PushService,
  ) {}

  async sendText(
    to: MessageRecipient,
    body: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.deliver("sendText", to, options, (adapter) =>
      adapter.sendText(to, body),
    );
  }

  async sendButtons(
    to: MessageRecipient,
    body: string,
    buttons: ReplyButton[],
    options?: SendOptions,
  ): Promise<void> {
    await this.deliver("sendButtons", to, options, (adapter) =>
      adapter.sendButtons(to, body, buttons),
    );
  }

  async sendList(
    to: MessageRecipient,
    body: string,
    buttonLabel: string,
    rows: ListOption[],
    options?: SendOptions,
  ): Promise<void> {
    await this.deliver("sendList", to, options, (adapter) =>
      adapter.sendList(to, body, buttonLabel, rows),
    );
  }

  async sendChunked(
    to: MessageRecipient,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.deliver("sendChunked", to, options, (adapter) =>
      adapter.sendChunked(to, text),
    );
  }

  async requestForm(
    to: MessageRecipient,
    form: FormRequest,
    options?: SendOptions,
  ): Promise<boolean> {
    return await this.deliver("requestForm", to, options, (adapter) =>
      adapter.requestForm(to, form),
    );
  }

  async sendTemplate(
    to: MessageRecipient,
    templateName: string,
    languageCode: string,
    components?: unknown[],
    options?: SendOptions,
  ): Promise<void> {
    await this.deliver("sendTemplate", to, options, (adapter) =>
      adapter.sendTemplate(to, templateName, languageCode, components),
    );
  }

  /**
   * Where a send with these options would go, without sending it. For callers
   * that must say it differently per channel: the allowance nudge needs a
   * WhatsApp template only when it is actually going to WhatsApp.
   */
  async resolveDelivery(
    to: MessageRecipient,
    options?: SendOptions,
  ): Promise<Channel> {
    return (await this.plan("resolveDelivery", to, options)).channel;
  }

  private async deliver<T>(
    method: string,
    to: MessageRecipient,
    options: SendOptions | undefined,
    send: (adapter: ChannelAdapter) => Promise<T>,
  ): Promise<T> {
    const plan = await this.plan(method, to, options);
    const result = await send(this.adapter(plan.channel));

    // Both are extras on a message already delivered: a failure is logged,
    // never allowed to fail the send, which may sit inside a money path.
    if (plan.mirrorToApp) {
      await send(this.app).catch((err) =>
        this.logger.warn(
          `${method}: copying to the app chat for user ${to.id} failed: ${String(err)}`,
        ),
      );
    }
    if (plan.push) {
      await this.push.notify(
        to.id,
        options?.delivery === "proactive" ? "proactive" : "transactional",
      );
    }
    return result;
  }

  private async plan(
    method: string,
    to: MessageRecipient,
    options?: SendOptions,
  ): Promise<DeliveryPlan> {
    if (options?.channel) return { ...REPLY_PLAN, channel: options.channel };

    const context = currentChannelContext();
    if (context) return { ...REPLY_PLAN, channel: context.channel };

    const delivery = options?.delivery ?? "reply";
    if (delivery === "reply") this.reportMissingContext(method);
    return this.policy.plan(to, { delivery, origin: options?.origin });
  }

  private adapter(channel: Channel): ChannelAdapter {
    return channel === "app" ? this.app : this.whatsapp;
  }

  /**
   * A reply with nobody to reply to means an entry point forgot to open a
   * channel context, or a proactive send was not labelled as one. Either way
   * the message still goes out, by delivery policy, but it is logged rather
   * than swallowed.
   */
  protected reportMissingContext(method: string): void {
    this.logger.warn(
      `${method} sent as a reply outside any channel context — routed by delivery policy. Open a context at the entry point, or mark the send as proactive/transactional.`,
    );
  }
}
