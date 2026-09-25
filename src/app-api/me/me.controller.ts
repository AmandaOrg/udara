import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";

/** The signed-in user, as much as the app needs to decide what to show next. */
@Controller("v1/me")
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentPrincipal() principal: AppPrincipal) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
    });
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      name: user.name,
      onboardingStage: user.onboardingStage,
      hasPin: user.pinHash !== null,
      whatsappLinked: user.whatsappNumber !== null,
      hasEmail: user.email !== null,
    };
  }
}
