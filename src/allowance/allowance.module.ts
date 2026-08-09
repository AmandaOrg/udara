import { Module } from '@nestjs/common';
import { AllowanceService } from './allowance.service';
import { WindowService } from './window.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { AllowanceScheduler } from './allowance.scheduler';

@Module({
  providers: [AllowanceService, WindowService, FeeCalculatorService, AllowanceScheduler],
  exports: [AllowanceService, WindowService, FeeCalculatorService],
})
export class AllowanceModule {}
