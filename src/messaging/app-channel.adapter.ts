import { Injectable, Logger } from "@nestjs/common";
import { splitIntoChunks } from "../whatsapp/chunked-messenger.service";
import { AppMessageService } from "./app-message.service";
import type {
  ChannelAdapter,
  FormRequest,
  ListOption,
  MessageRecipient,
  ReplyButton,
} from "./channel-messenger";

/**
 * Delivery into the in-app chat: one AppMessage row per bubble, which the app
 * reads by polling. No typing pauses between bubbles; the app animates those
 * itself if it wants them.
 */
@Injectable()
export class AppChannelAdapter implements ChannelAdapter {
  readonly channel = "app" as const;
  private readonly logger = new Logger(AppChannelAdapter.name);

  constructor(private readonly store: AppMessageService) {}

  async sendText(to: MessageRecipient, body: string): Promise<void> {
    await this.store.recordOutbound(to.id, { kind: "TEXT", body });
  }

  async sendButtons(
    to: MessageRecipient,
    body: string,
    buttons: ReplyButton[],
  ): Promise<void> {
    await this.store.recordOutbound(to.id, { kind: "BUTTONS", body, buttons });
  }

  async sendList(
    to: MessageRecipient,
    body: string,
    buttonLabel: string,
    rows: ListOption[],
  ): Promise<void> {
    await this.store.recordOutbound(to.id, {
      kind: "LIST",
      body,
      buttonLabel,
      rows,
    });
  }

  async sendChunked(to: MessageRecipient, text: string): Promise<void> {
    for (const chunk of splitIntoChunks(text)) {
      await this.store.recordOutbound(to.id, { kind: "TEXT", body: chunk });
    }
  }

  /** The app has a native screen for every form kind, so this always shows. */
  async requestForm(to: MessageRecipient, form: FormRequest): Promise<boolean> {
    await this.store.recordOutbound(to.id, { kind: "FORM_REQUEST", form });
    return true;
  }

  /**
   * WhatsApp templates exist to reopen a conversation Meta has closed. The app
   * has no such window and no template text to render, so nothing is written.
   * The only template sender is the allowance nudge, which is proactive and is
   * rerouted by the P5 delivery policy.
   */
  async sendTemplate(
    to: MessageRecipient,
    templateName: string,
  ): Promise<void> {
    this.logger.warn(
      `sendTemplate(${templateName}) for user ${to.id} on the app channel — nothing sent`,
    );
  }
}
