import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from "class-validator";
import { MAX_PAGE_SIZE } from "./transaction-history.service";

export class TransactionsQueryDto {
  /** `nextCursor` from the previous page. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,120}$/)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

export class SpendSummaryQueryDto {
  /** This WAT week (from Monday) or this WAT month, to date. */
  @IsOptional()
  @IsIn(["week", "month"])
  period?: "week" | "month";
}
