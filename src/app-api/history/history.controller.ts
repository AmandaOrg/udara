import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { SpendSummaryService } from "../../allowance/spend-summary.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import {
  decodeCursor,
  TransactionHistoryService,
} from "./transaction-history.service";
import { SpendSummaryQueryDto, TransactionsQueryDto } from "./history.dto";
import { HistoryPageView, SpendSummaryView } from "./history.view";

/** What the user has spent and received. Empty before the account exists. */
@Controller("v1")
export class HistoryController {
  constructor(
    private readonly history: TransactionHistoryService,
    private readonly spend: SpendSummaryService,
  ) {}

  @Get("transactions")
  async transactions(
    @CurrentPrincipal() principal: AppPrincipal,
    @Query() query: TransactionsQueryDto,
  ): Promise<HistoryPageView> {
    let cursor;
    if (query.cursor !== undefined) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) throw new BadRequestException({ error: "bad_cursor" });
    }
    return this.history.page(
      principal.userId,
      cursor ?? undefined,
      query.limit,
    );
  }

  /** Transfers only, as in the weekly check-in. */
  @Get("spend-summary")
  async spendSummary(
    @CurrentPrincipal() principal: AppPrincipal,
    @Query() query: SpendSummaryQueryDto,
  ): Promise<SpendSummaryView> {
    const period = query.period ?? "week";
    const summary =
      period === "month"
        ? await this.spend.getMonthlySummary(principal.userId)
        : await this.spend.getWeeklySummary(principal.userId);
    return {
      period,
      periodStart: summary.weekStartDate.toISOString(),
      totalSpent: summary.totalSpent,
      transactionCount: summary.transactionCount,
      byDay: summary.byDay,
      byLabel: summary.byLabel,
    };
  }
}
