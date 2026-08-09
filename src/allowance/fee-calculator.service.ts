import { Injectable } from '@nestjs/common';
import { TransactionType } from '../common/enums/transaction-type.enum';

export interface FeeResult {
  feeAmount: number;
  waived: boolean;
}

/**
 * Pure calculation, no side effects — deliberately kept out of AllowanceService
 * so the fee math is independently unit-testable against the exact figures in
 * the PRD (section 3/4.1): early access ₦1,000 + 0.2%, borrowing ₦1,000 + 0.4%,
 * waived if prior-day surplus covers the amount.
 */
@Injectable()
export class FeeCalculatorService {
  private readonly EARLY_ACCESS_FLAT = Number(process.env.EARLY_ACCESS_FLAT_FEE ?? 1000);
  private readonly EARLY_ACCESS_PCT = Number(process.env.EARLY_ACCESS_PERCENT_FEE ?? 0.002);
  private readonly BORROW_FLAT = Number(process.env.BORROW_FLAT_FEE ?? 1000);
  private readonly BORROW_PCT = Number(process.env.BORROW_PERCENT_FEE ?? 0.004);

  calculate(
    type: TransactionType,
    amount: number,
    surplusAvailable: number,
  ): FeeResult {
    if (type === TransactionType.NORMAL) {
      return { feeAmount: 0, waived: false };
    }

    // Borrowing is waived (free) up to the amount covered by yesterday's
    // leftover surplus — only the portion beyond that is fee-bearing.
    if (type === TransactionType.BORROWED && surplusAvailable >= amount) {
      return { feeAmount: 0, waived: true };
    }

    if (type === TransactionType.EARLY_ACCESS) {
      return {
        feeAmount: this.EARLY_ACCESS_FLAT + amount * this.EARLY_ACCESS_PCT,
        waived: false,
      };
    }

    // BORROWED, not fully covered by surplus
    return {
      feeAmount: this.BORROW_FLAT + amount * this.BORROW_PCT,
      waived: false,
    };
  }
}
