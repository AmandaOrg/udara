import { Module } from "@nestjs/common";
import { AllowanceService } from "./allowance.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { AllowanceScheduler } from "./allowance.scheduler";
import { SpendSummaryService } from "./spend-summary.service";

@Module({
  providers: [
    AllowanceService,
    WindowService,
    FeeCalculatorService,
    AllowanceScheduler,
    SpendSummaryService,
  ],
  exports: [
    AllowanceService,
    WindowService,
    FeeCalculatorService,
    SpendSummaryService,
  ],
})
export class AllowanceModule {}
