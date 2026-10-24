import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { AppConversationService } from "./app-conversation.service";
import { ListMessagesQueryDto, SendMessageDto, StartDto } from "./chat.dto";

/**
 * Talking to Udara in the app: the same conversation as WhatsApp, onboarding
 * included. Sends are accepted with 202 and answered in the message list.
 * No logger here (S15): message text is the user's own words.
 */
@Controller("v1/chat")
export class ChatController {
  constructor(private readonly chat: AppConversationService) {}

  @Post("messages")
  @HttpCode(HttpStatus.ACCEPTED)
  send(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: SendMessageDto,
  ) {
    if ((dto.text === undefined) === (dto.reply === undefined)) {
      throw new BadRequestException({ error: "text_or_reply" });
    }
    return dto.reply
      ? this.chat.sendChoice(principal, dto.clientMessageId, dto.reply)
      : this.chat.sendText(principal, dto.clientMessageId, dto.text!);
  }

  @Get("messages")
  list(
    @CurrentPrincipal() principal: AppPrincipal,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.chat.list(
      principal,
      query.after === undefined ? undefined : BigInt(query.after),
      query.waitMs ?? 0,
    );
  }

  /** Opens the conversation for a new user; harmless to call again. */
  @Post("start")
  @HttpCode(HttpStatus.ACCEPTED)
  start(@CurrentPrincipal() principal: AppPrincipal, @Body() dto: StartDto) {
    return this.chat.start(principal, dto.clientMessageId);
  }
}
