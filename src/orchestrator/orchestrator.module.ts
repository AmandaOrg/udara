/**
 * Orchestrator brain (LLM + validator) with no WhatsApp send dependencies.
 * ActionExecutor is provided by WhatsappModule — it needs account/WhatsApp services.
 */

import { Module, forwardRef } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AllowanceModule } from "../allowance/allowance.module";
import { OrchestratorService } from "./orchestrator.service";
import { ActionValidatorService } from "./action-validator.service";

@Module({
  imports: [AiModule, forwardRef(() => AllowanceModule)],
  providers: [OrchestratorService, ActionValidatorService],
  exports: [OrchestratorService, ActionValidatorService],
})
export class OrchestratorModule {}
