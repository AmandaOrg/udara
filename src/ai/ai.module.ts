import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CLASSIFIER_LLM, CONVERSATION_LLM } from "./llm.types";
// CLASSIFIER_LLM is referenced by llmProvider() below but no longer provided;
// see the providers array.
import { AnthropicLlmService } from "./providers/anthropic-llm.service";
import { OpenRouterLlmService } from "./providers/openrouter-llm.service";
import { GeminiLlmService } from "./providers/gemini-llm.service";
import { BedrockLlmService } from "./providers/bedrock-llm.service";
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
 * "gemini" / "bedrock" use the same shared-key/fast-vs-model split as
 * "openrouter" (provider-specific env vars), not the Anthropic-shaped
 * CLASSIFIER_MODEL_/CONVERSATION_MODEL_ pair.
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
      if (provider === "bedrock") {
        return new BedrockLlmService(config, role);
      }
      return new StubLlmService();
    },
    inject: [ConfigService],
  };
}

@Module({
  providers: [
    // Only the conversation role is wired. The classifier token existed for
    // IntentRouterService, which the orchestrator replaced and which is now
    // deleted — but the factory keeps its role parameter, so re-adding a
    // classifier is a one-line change plus the CLASSIFIER_MODEL_* env vars that
    // are still documented in .env.example.
    llmProvider("conversation"),
    ExtractionValidatorService,
    LlmCallLoggerService,
  ],
  exports: [CONVERSATION_LLM, ExtractionValidatorService, LlmCallLoggerService],
})
export class AiModule {}
