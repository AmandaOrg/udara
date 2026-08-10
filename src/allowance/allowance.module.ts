import { forwardRef, Module } from "@nestjs/common";
import { AllowanceService } from "./allowance.service";
import { WindowService } from "./window.service";
import { FeeCalculatorService } from "./fee-calculator.service";
import { AllowanceScheduler } from "./allowance.scheduler";
import { SpendSummaryService } from "./spend-summary.service";
import { WhatsappModule } from "../whatsapp/whatsapp.module";

@Module({
  // forwardRef: WhatsappModule already imports AllowanceModule, and
  // AllowanceScheduler needs WhatsappService back for the window-open nudge
  // (PRD §13) — same circular pattern as Rubies/Manager, resolved the same way.
  imports: [forwardRef(() => WhatsappModule)],
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
