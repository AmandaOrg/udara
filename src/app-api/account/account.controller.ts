import { Controller, Get } from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { AccountOverviewService } from "./account-overview.service";
import { AccountView, BalanceView, LimitsView } from "./account.view";

/** Balance, limits and the account's own details. 409 before it exists. */
@Controller("v1")
export class AccountController {
  constructor(private readonly overview: AccountOverviewService) {}

  @Get("balance")
  balance(@CurrentPrincipal() principal: AppPrincipal): Promise<BalanceView> {
    return this.overview.balance(principal.userId);
  }

  @Get("limits")
  limits(@CurrentPrincipal() principal: AppPrincipal): Promise<LimitsView> {
    return this.overview.limits(principal.userId);
  }

  /** What someone needs to fund the account. */
  @Get("account")
  account(@CurrentPrincipal() principal: AppPrincipal): Promise<AccountView> {
    return this.overview.account(principal.userId);
  }
}
