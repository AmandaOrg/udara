import { forwardRef, Module } from "@nestjs/common";
import { AllowanceService } from "./allowance.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { AllowanceScheduler } from "./allowance.scheduler";
import { SpendSummaryService } from "./spend-summary.service";
import { MessagingModule } from "../messaging/messaging.module";
import { EmailModule } from "../email/email.module";

@Module({
  // AllowanceScheduler sends its nudges through MessagingModule, which depends on
  // no domain module. EmailModule and AllowanceModule still import each other.
  imports: [MessagingModule, forwardRef(() => EmailModule)],
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
