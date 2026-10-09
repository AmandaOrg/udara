import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { SettingsChangeType } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppPrincipal } from "../../app-auth/session.service";
import {
  ManagerService,
  OPEN_REQUEST_STATUSES,
} from "../../manager/manager.service";
import { ManagerConversationService } from "../../manager/manager-conversation.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { inApp } from "../payments.util";
import {
  CreateSettingsRequestDto,
  FileableRequestType,
} from "./settings-requests.dto";
import {
  SettingsRequestListView,
  SettingsRequestView,
  toSettingsRequestView,
} from "./settings-requests.view";

/** Each request schedules a reply from the managers' model; a few an hour is plenty. */
const FILE_THROTTLE = { default: { limit: 5, ttl: 60 * 60_000 } };

const TYPE: Record<FileableRequestType, SettingsChangeType> = {
  window_hours: SettingsChangeType.WINDOW_HOURS,
  override_fees: SettingsChangeType.OVERRIDE_FEES,
  exit_restrictions: SettingsChangeType.EXIT_RESTRICTIONS,
  other: SettingsChangeType.OTHER,
};

/**
 * Requests to the managers from the app's settings: the same request the chat
 * files (ADR-0001), with the same seven-day gate and the same delayed reply.
 * Only ever the caller's own requests.
 */
@Controller("v1/settings-requests")
export class SettingsRequestsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly managers: ManagerConversationService,
    private readonly manager: ManagerService,
  ) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AppPrincipal,
  ): Promise<SettingsRequestListView> {
    const requests = await this.prisma.settingsChangeRequest.findMany({
      where: { userId: principal.userId },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    return { requests: requests.map(toSettingsRequestView) };
  }

  /**
   * One open request of a kind at a time: a second while the first waits
   * would only restart nothing and cost another reply.
   */
  @Throttle(FILE_THROTTLE)
  @Post()
  async file(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: CreateSettingsRequestDto,
  ): Promise<SettingsRequestView> {
    const type = TYPE[dto.type];
    const open = await this.prisma.settingsChangeRequest.findFirst({
      where: {
        userId: principal.userId,
        type,
        status: { in: OPEN_REQUEST_STATUSES },
      },
    });
    if (open) {
      throw new ConflictException({
        error: "request_open",
        request: toSettingsRequestView(open),
      });
    }

    // In the app's channel context, so the managers' acknowledgement lands in
    // the app chat, as it would in WhatsApp for a request filed there.
    const request = await inApp(principal, () =>
      this.managers.fileChangeRequest({
        userId: principal.userId,
        type,
        requestedChange: dto.requestedChange.trim(),
        reason: dto.reason?.trim() || undefined,
      }),
    );
    return toSettingsRequestView(request);
  }

  /** Allowed until the request is decided, a closure request included. */
  @Post(":id/withdraw")
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<SettingsRequestView> {
    const result = await this.manager.withdrawRequest(principal.userId, id);
    if (!result.ok) {
      throw result.reason === "not_found"
        ? new NotFoundException({ error: "not_found" })
        : new ConflictException({ error: "already_decided" });
    }
    return toSettingsRequestView(result.request);
  }
}
