import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CLASSIFIER_LLM, CONVERSATION_LLM } from "./llm.types";
import { AnthropicLlmService } from "./providers/anthropic-llm.service";
import { OpenRouterLlmService } from "./providers/openrouter-llm.service";
import { GeminiLlmService } from "./providers/gemini-llm.service";
import { StubLlmService } from "./providers/stub-llm.service";
import { ExtractionValidatorService } from "./extraction-validator.service";
import { LlmCallLoggerService } from "./llm-call-logger.service";

/**
 * Builds the CLASSIFIER_LLM/CONVERSATION_LLM providers. Each resolves to a
 * concrete LlmService chosen by AI_PROVIDER at boot — a config flip, not a
 * code change, per the classification-vs-conversation model split already
 * present in .env.example (the CLASSIFIER_MODEL_ and CONVERSATION_MODEL_ prefixed var pairs).
 * useFactory (not a plain @Injectable class) because AnthropicLlmService
 * needs two differently-configured instances, not one shared singleton.
 * "gemini" is a fourth provider option (see gemini-llm.service.ts) — same
 * shared-key/fast-model-vs-model split as "openrouter", using GOOGLE_API_KEY/
 * GEMINI_FAST_MODEL/GEMINI_MODEL instead of the generic CLASSIFIER_MODEL_/
 * CONVERSATION_MODEL_ var pair (which stays Anthropic-shaped).
 */
function llmProvider(role: "classifier" | "conversation"): Provider {
  const token = role === "classifier" ? CLASSIFIER_LLM : CONVERSATION_LLM;
  const modelEnvKey =
    role === "classifier" ? "CLASSIFIER_MODEL_NAME" : "CONVERSATION_MODEL_NAME";
  const apiKeyEnvKey =
    role === "classifier"
      ? "CLASSIFIER_MODEL_API_KEY"
      : "CONVERSATION_MODEL_API_KEY";

  return {
    provide: token,
    useFactory: (config: ConfigService) => {
      const provider = config.get<string>("AI_PROVIDER", "stub");
      if (provider === "anthropic") {
        return new AnthropicLlmService(config, role, modelEnvKey, apiKeyEnvKey);
      }
      if (provider === "openrouter") {
        return new OpenRouterLlmService(config, role);
      }
      if (provider === "gemini") {
        return new GeminiLlmService(config, role);
      }
      return new StubLlmService();
    },
    inject: [ConfigService],
  };
}

@Module({
  providers: [
    llmProvider("classifier"),
    llmProvider("conversation"),
    ExtractionValidatorService,
    LlmCallLoggerService,
  ],
  exports: [
    CLASSIFIER_LLM,
    CONVERSATION_LLM,
    ExtractionValidatorService,
    LlmCallLoggerService,
  ],
})
export class AiModule {}
