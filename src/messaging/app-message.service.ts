import { Injectable } from "@nestjs/common";
import {
  AppMessage,
  AppMessageDirection,
  AppMessageKind,
  AppMessageStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { scrubFreeTextSecrets } from "../whatsapp/scrub-free-text.util";
import type { FormRequest, ListOption, ReplyButton } from "./channel-messenger";
import { AppMessageNotifier } from "./app-message.notifier";

export type AppOutbound =
  | { kind: "TEXT"; body: string }
  | { kind: "BUTTONS"; body: string; buttons: ReplyButton[] }
  | { kind: "LIST"; body: string; buttonLabel: string; rows: ListOption[] }
  | { kind: "FORM_REQUEST"; form: FormRequest };

export type AppInboundKind = "TEXT" | "CHOICE" | "FORM_SUBMISSION" | "START";

export interface AppInbound {
  clientMessageId: string;
  kind: AppInboundKind;
  body?: string;
  /** What was chosen or which form arrived. Never a form's values. */
  payload?: Prisma.InputJsonValue;
}

/** Rows returned by one poll. */
export const PAGE_SIZE = 50;

/**
 * The in-app chat's storage: every bubble Udara sends, every message the user
 * sends, and the cursor the app reads them by.
 *
 * Inbound text is scrubbed here, on the way into the database, for the same
 * reason WhatsappMessageService scrubs: someone whose form did not open will
 * type their PIN or BVN into the chat, and once the row exists no handler can
 * take it back.
 */
@Injectable()
export class AppMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: AppMessageNotifier,
  ) {}

  async recordOutbound(
    userId: string,
    message: AppOutbound,
  ): Promise<AppMessage> {
    const row = await this.prisma.appMessage.create({
      data: {
        userId,
        direction: AppMessageDirection.OUTBOUND,
        kind: message.kind,
        ...outboundContent(message),
      },
    });
    this.notifier.notify(userId);
    return row;
  }

  /**
   * Stores an inbound message once per `clientMessageId`. A retry of the same
   * send returns the original row with `isNew: false`, and must not be
   * processed again.
   */
  async recordInbound(
    userId: string,
    input: AppInbound,
  ): Promise<{ row: AppMessage; isNew: boolean }> {
    try {
      const row = await this.prisma.appMessage.create({
        data: {
          userId,
          direction: AppMessageDirection.INBOUND,
          kind: input.kind,
          body:
            input.body === undefined
              ? undefined
              : scrubFreeTextSecrets(input.body),
          payload: input.payload,
          clientMessageId: input.clientMessageId,
          status: AppMessageStatus.RECEIVED,
        },
      });
      this.notifier.notify(userId);
      return { row, isNew: true };
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      ) {
        throw err;
      }
      const row = await this.prisma.appMessage.findUniqueOrThrow({
        where: {
          userId_clientMessageId: {
            userId,
            clientMessageId: input.clientMessageId,
          },
        },
      });
      return { row, isNew: false };
    }
  }

  async markProcessed(
    id: string,
    status: "PROCESSED" | "FAILED",
  ): Promise<void> {
    const row = await this.prisma.appMessage.update({
      where: { id },
      data: { status, processedAt: new Date() },
    });
    // The "still working on it" flag the app shows comes from this status.
    this.notifier.notify(row.userId);
  }

  /** Rows after the cursor, oldest first; with no cursor, the latest page. */
  async list(userId: string, after?: bigint): Promise<AppMessage[]> {
    if (after !== undefined) {
      return this.prisma.appMessage.findMany({
        where: { userId, seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: PAGE_SIZE,
      });
    }
    const latest = await this.prisma.appMessage.findMany({
      where: { userId },
      orderBy: { seq: "desc" },
      take: PAGE_SIZE,
    });
    return latest.reverse();
  }

  /** True while any of this user's inbound messages is still being handled. */
  async isProcessing(userId: string): Promise<boolean> {
    const pending = await this.prisma.appMessage.findFirst({
      where: {
        userId,
        direction: AppMessageDirection.INBOUND,
        status: AppMessageStatus.RECEIVED,
      },
      select: { id: true },
    });
    return pending !== null;
  }

  /**
   * The title of `choiceId` if `messageId` is a buttons or list message sent
   * to this user that offered it, else null.
   *
   * The app can name any message id and any choice id it likes; WhatsApp could
   * only ever send back a button Meta had shown the sender. This restores that
   * guarantee before a choice reaches a handler.
   */
  async findOfferedChoice(
    userId: string,
    messageId: string,
    choiceId: string,
  ): Promise<string | null> {
    const offer = await this.prisma.appMessage.findFirst({
      where: {
        id: messageId,
        userId,
        direction: AppMessageDirection.OUTBOUND,
        kind: { in: [AppMessageKind.BUTTONS, AppMessageKind.LIST] },
      },
    });
    if (!offer) return null;
    const match = offeredOptions(offer.payload).find((o) => o.id === choiceId);
    return match ? match.title : null;
  }
}

function outboundContent(message: AppOutbound): {
  body?: string;
  payload?: Prisma.InputJsonValue;
} {
  switch (message.kind) {
    case "TEXT":
      return { body: message.body };
    case "BUTTONS":
      return {
        body: message.body,
        payload: {
          buttons: message.buttons,
        } as unknown as Prisma.InputJsonValue,
      };
    case "LIST":
      return {
        body: message.body,
        payload: {
          buttonLabel: message.buttonLabel,
          rows: message.rows,
        } as unknown as Prisma.InputJsonValue,
      };
    case "FORM_REQUEST":
      return {
        body: message.form.bodyText,
        payload: {
          form: message.form.kind,
          token: message.form.token,
          headerText: message.form.headerText,
          bodyText: message.form.bodyText,
          ctaText: message.form.ctaText,
        },
      };
  }
}

function offeredOptions(
  payload: Prisma.JsonValue,
): { id: string; title: string }[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const options = Array.isArray(record.buttons)
    ? record.buttons
    : Array.isArray(record.rows)
      ? record.rows
      : [];
  return options.filter(
    (o): o is { id: string; title: string } =>
      !!o &&
      typeof o === "object" &&
      typeof (o as { id?: unknown }).id === "string" &&
      typeof (o as { title?: unknown }).title === "string",
  );
}
