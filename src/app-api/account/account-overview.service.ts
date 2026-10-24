import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { User } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  RUBIES_MFB_BANK_CODE,
  RubiesService,
} from "../../rubies/rubies.service";
import { AllowanceService } from "../../allowance/allowance.service";
import { WindowService } from "../../allowance/window.service";
import { describeLimits } from "../../allowance/limits-status";
import type { AccountView, BalanceView, LimitsView } from "./account.view";

type UserWithAccount = User & { rubiesAccountNumber: string };

/** The home screen's figures, for the signed-in user only. */
@Injectable()
export class AccountOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly allowance: AllowanceService,
    private readonly windowService: WindowService,
  ) {}

  /** Always a live Rubies read, as on WhatsApp; never a stored figure. */
  async balance(userId: string): Promise<BalanceView> {
    const user = await this.withAccount(userId);
    const balance = await this.rubies
      .getBalance(user.rubiesAccountNumber)
      .catch(() => null);
    if (balance === null) {
      throw new ServiceUnavailableException({ error: "balance_unavailable" });
    }
    return { balance };
  }

  /**
   * Needs the account: reading the figures creates today's allowance row,
   * which before the plan is set would be wrong.
   */
  async limits(userId: string): Promise<LimitsView> {
    const user = await this.withAccount(userId);
    return describeLimits(
      user,
      await this.allowance.getRemainingSummary(user.id),
      this.windowService,
    );
  }

  async account(userId: string): Promise<AccountView> {
    const user = await this.withAccount(userId);
    return {
      accountNumber: user.rubiesAccountNumber,
      accountName: user.rubiesAccountName,
      bankName: "Rubies MFB",
      bankCode: user.rubiesBankCode ?? RUBIES_MFB_BANK_CODE,
    };
  }

  private async withAccount(userId: string): Promise<UserWithAccount> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.rubiesAccountNumber) {
      throw new ConflictException({ error: "no_account" });
    }
    return user as UserWithAccount;
  }
}
