import { Controller, Get } from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { TaggingService } from "../../tagging/tagging.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { BankDirectoryService } from "../banks/bank-directory.service";
import { RecipientsView } from "./recipients.view";

/** The people the user has sent to before. */
@Controller("v1/recipients")
export class RecipientsController {
  constructor(
    private readonly tagging: TaggingService,
    private readonly banks: BankDirectoryService,
  ) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: AppPrincipal,
  ): Promise<RecipientsView> {
    const recipients = await this.tagging.listRecipientsForUser(
      principal.userId,
    );
    const names =
      recipients.length > 0
        ? await this.banks.names()
        : new Map<string, string>();
    return {
      recipients: recipients.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        accountName: r.accountName,
        accountNumber: r.accountNumber,
        bankCode: r.bankCode,
        bankName: names.get(r.bankCode) ?? null,
        label: r.label,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      })),
    };
  }
}
