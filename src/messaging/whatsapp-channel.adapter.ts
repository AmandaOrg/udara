import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { ChunkedMessengerService } from "../whatsapp/chunked-messenger.service";
import type {
  ChannelAdapter,
  FormKind,
  FormRequest,
  ListOption,
  MessageRecipient,
  ReplyButton,
} from "./channel-messenger";

/**
 * Each form is a WhatsApp Flow published in Meta Business Manager, so its id
 * is per-environment config. See docs/whatsapp-flows/.
 */
const FLOWS: Record<FormKind, { envVar: string; screenId: string }> = {
  KYC: { envVar: "WHATSAPP_KYC_FLOW_ID", screenId: "KYC" },
  PIN_SETUP: { envVar: "WHATSAPP_PIN_SETUP_FLOW_ID", screenId: "PIN_SETUP" },
  PIN_ENTRY: { envVar: "WHATSAPP_PIN_ENTRY_FLOW_ID", screenId: "PIN_ENTRY" },
  PIN_RESET: { envVar: "WHATSAPP_PIN_RESET_FLOW_ID", screenId: "PIN_RESET" },
};

/**
 * WhatsApp delivery, exactly as it was before the messenger port existed: the
 * same WhatsappService calls, the same outbound rows, the same typing
 * indicator and pauses between bubbles. Anything WhatsApp-specific about
 * *how* a message goes out belongs here, not in the services deciding what
 * to say.
 */
@Injectable()
export class WhatsappChannelAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  private readonly logger = new Logger(WhatsappChannelAdapter.name);

  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly chunkedMessenger: ChunkedMessengerService,
    private readonly config: ConfigService,
  ) {}

  async sendText(to: MessageRecipient, body: string): Promise<void> {
    await this.whatsapp.sendText(to.whatsappNumber, body, to.id);
  }

  async sendButtons(
    to: MessageRecipient,
    body: string,
    buttons: ReplyButton[],
  ): Promise<void> {
    await this.whatsapp.sendInteractiveButtons(
      to.whatsappNumber,
      body,
      buttons,
      to.id,
    );
  }

  async sendList(
    to: MessageRecipient,
    body: string,
    buttonLabel: string,
    rows: ListOption[],
  ): Promise<void> {
    await this.whatsapp.sendListMessage(
      to.whatsappNumber,
      body,
      buttonLabel,
      rows,
      to.id,
    );
  }

  async sendChunked(to: MessageRecipient, text: string): Promise<void> {
    await this.chunkedMessenger.sendChunkedReply(
      to.whatsappNumber,
      text,
      to.id,
    );
  }

  /**
   * An unset Flow id is a real state, not an error: a Flow has to be published
   * in Meta Business Manager before it has an id, and a dev environment may
   * not have done that. Warn loudly and let the caller tell the user.
   */
  async requestForm(to: MessageRecipient, form: FormRequest): Promise<boolean> {
    const { envVar, screenId } = FLOWS[form.kind];
    const flowId = this.config.get<string>(envVar);
    if (!flowId) {
      this.logger.warn(
        `${envVar} is not set — cannot send the ${form.kind} form. See docs/whatsapp-flows/.`,
      );
      return false;
    }

    await this.whatsapp.sendFlow({
      to: to.whatsappNumber,
      flowId,
      flowToken: form.token,
      screenId,
      headerText: form.headerText,
      bodyText: form.bodyText,
      ctaText: form.ctaText,
      userId: to.id,
    });
    return true;
  }

  async sendTemplate(
    to: MessageRecipient,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<void> {
    await this.whatsapp.sendTemplate(
      to.whatsappNumber,
      templateName,
      languageCode,
      components,
      to.id,
    );
  }
}
