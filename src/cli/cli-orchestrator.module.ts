/**
 * Nest module for the orchestrator dry-run CLI.
 * Does not import WhatsappModule, RubiesModule, AiModule, or ActionExecutor.
 * LLM wiring is inlined so we never pull AiModule's Prisma-backed LlmCallLogger.
 */

import { DynamicModule, Module, Provider } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CONVERSATION_LLM } from "../ai/llm.types";
import { AnthropicLlmService } from "../ai/providers/anthropic-llm.service";
import { OpenRouterLlmService } from "../ai/providers/openrouter-llm.service";
import { GeminiLlmService } from "../ai/providers/gemini-llm.service";
import { BedrockLlmService } from "../ai/providers/bedrock-llm.service";
import { StubLlmService } from "../ai/providers/stub-llm.service";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { PrismaService } from "../prisma/prisma.service";
import { AllowanceService } from "../allowance/allowance.service";
import { WindowService } from "../allowance/window.service";
import { OrchestratorService } from "../orchestrator/orchestrator.service";
import { ActionValidatorService } from "../orchestrator/action-validator.service";
import { validate } from "../config/env.validation";
import { CliPrismaStub } from "./cli-prisma.stub";
import { CliNoopLlmLogger } from "./cli-noop-llm-logger";
import { FixtureLlmService } from "./fixture-llm.service";

const FIXED_ALLOWANCE = {
  getRemainingSummary: async () => ({
    remainingToday: 5000,
    remainingWeek: 20000,
  }),
  evaluateSpend: async () => ({ type: "NORMAL" }),
};

function conversationLlmProvider(): Provider {
  return {
    provide: CONVERSATION_LLM,
    useFactory: (config: ConfigService) => {
      const provider = config.get<string>("AI_PROVIDER", "stub");
      if (provider === "anthropic") {
        return new AnthropicLlmService(
          config,
          "conversation",
          "CONVERSATION_MODEL_NAME",
          "CONVERSATION_MODEL_API_KEY",
        );
      }
      if (provider === "openrouter") {
        return new OpenRouterLlmService(config, "conversation");
      }
      if (provider === "gemini") {
        return new GeminiLlmService(config, "conversation");
      }
      if (provider === "bedrock") {
        return new BedrockLlmService(config, "conversation");
      }
      return new StubLlmService();
    },
    inject: [ConfigService],
  };
}

export type CliOrchestratorModuleOptions = {
  /** When true, CONVERSATION_LLM is FixtureLlmService. */
  useFixtureLlm: boolean;
};

@Module({})
export class CliOrchestratorModule {
  static forRoot(options: CliOrchestratorModuleOptions): DynamicModule {
    const llmProviders: Provider[] = options.useFixtureLlm
      ? [
          FixtureLlmService,
          { provide: CONVERSATION_LLM, useExisting: FixtureLlmService },
        ]
      : [conversationLlmProvider()];

    return {
      module: CliOrchestratorModule,
      imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
      providers: [
        CliPrismaStub,
        { provide: PrismaService, useExisting: CliPrismaStub },
        CliNoopLlmLogger,
        { provide: LlmCallLoggerService, useExisting: CliNoopLlmLogger },
        { provide: AllowanceService, useValue: FIXED_ALLOWANCE },
        WindowService,
        ActionValidatorService,
        OrchestratorService,
        ...llmProviders,
      ],
      exports: options.useFixtureLlm
        ? [
            OrchestratorService,
            ActionValidatorService,
            FixtureLlmService,
            CliNoopLlmLogger,
          ]
        : [OrchestratorService, ActionValidatorService, CliNoopLlmLogger],
    };
  }
}
