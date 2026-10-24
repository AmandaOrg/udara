import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppPrincipal } from "../../app-auth/session.service";
import {
  TERMS_CONSENT_QUESTION,
  TERMS_SUMMARY,
  TERMS_VERSION,
  needsTermsConsent,
} from "../../onboarding/terms.data";
import { CurrentPrincipal } from "../current-principal.decorator";
import { AcceptTermsDto } from "./terms.dto";
import { TermsAcceptedView, TermsView } from "./terms.view";

/**
 * Re-consent when the terms change. First consent stays in the onboarding
 * conversation, where it moves the user on; this is only for someone who
 * agreed to an earlier version. Nothing is blocked while it is outstanding:
 * that is decided with the first real terms change (see the P9 tech design).
 */
@Controller("v1/terms")
export class TermsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentPrincipal() principal: AppPrincipal): Promise<TermsView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
    });
    return {
      version: TERMS_VERSION,
      summary: TERMS_SUMMARY,
      consentQuestion: TERMS_CONSENT_QUESTION,
      accepted: user.termsAcceptedAt
        ? { version: user.termsVersion, at: user.termsAcceptedAt.toISOString() }
        : null,
      needsConsent: needsTermsConsent(user),
    };
  }

  @Post("accept")
  @HttpCode(HttpStatus.OK)
  async accept(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: AcceptTermsDto,
  ): Promise<TermsAcceptedView> {
    if (dto.version !== TERMS_VERSION) {
      throw new ConflictException({
        error: "terms_changed",
        version: TERMS_VERSION,
      });
    }
    const now = new Date();
    // Only someone who has consented before: first consent belongs to the
    // onboarding conversation, which this would otherwise skip past.
    const { count } = await this.prisma.user.updateMany({
      where: { id: principal.userId, termsAcceptedAt: { not: null } },
      data: { termsAcceptedAt: now, termsVersion: TERMS_VERSION },
    });
    if (count === 0) throw new ConflictException({ error: "not_onboarded" });
    return { version: TERMS_VERSION, acceptedAt: now.toISOString() };
  }
}
