import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { BankDirectoryService } from "./bank-directory.service";
import { NameEnquiryService } from "./name-enquiry.service";
import { NameEnquiryDto } from "./banks.dto";
import { BanksView, NameEnquiryView } from "./banks.view";

/** Banks to send to, and who owns an account at one. */
@Controller("v1")
export class BanksController {
  constructor(
    private readonly directory: BankDirectoryService,
    private readonly nameEnquiry: NameEnquiryService,
  ) {}

  @Get("banks")
  async banks(): Promise<BanksView> {
    const banks = await this.directory.list();
    if (banks.length === 0) {
      throw new ServiceUnavailableException({ error: "banks_unavailable" });
    }
    return {
      banks: banks.map((b) => ({ code: b.bankCode, name: b.bankName })),
    };
  }

  /** Limited to 20 an hour per user; see NameEnquiryService. */
  @Post("name-enquiry")
  @HttpCode(HttpStatus.OK)
  lookup(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: NameEnquiryDto,
  ): Promise<NameEnquiryView> {
    return this.nameEnquiry.lookup(
      principal.userId,
      dto.accountNumber,
      dto.bankCode,
    );
  }
}
