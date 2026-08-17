import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmMessage,
  LlmService,
} from "../llm.types";

interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
  };
}

interface OpenRouterResponse {
  model: string;
  choices: OpenRouterChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string; code?: string | number };
}

/**
 * OpenRouter implementation — an OpenAI-compatible gateway in front of many
 * providers/models. Same DI shape as AnthropicLlmService (see ai.module.ts's
 * factory), but OpenRouter's own env vars (OPENROUTER_*) don't follow the
 * generic CLASSIFIER_MODEL_/CONVERSATION_MODEL_ naming, so model selection is
 * resolved directly here: OPENROUTER_FAST_MODEL for the classifier role,
 * OPENROUTER_MODEL for the conversation role. One shared OPENROUTER_API_KEY
 * covers both roles (OpenRouter doesn't key auth per model the way separate
 * Anthropic classifier/conversation API keys can).
 *
 * Structured output uses OpenAI-style function calling: when params.tool is
 * set, it's offered as a single function with tool_choice: 'auto' — same
 * "presence/absence of a tool call is the usable-answer signal" contract as
 * the Anthropic provider (see llm.types.ts).
 */
export class OpenRouterLlmService implements LlmService {
  private readonly logger = new Logger(`OpenRouterLlmService(${this.role})`);

  constructor(
    private readonly config: ConfigService,
    private readonly role: "classifier" | "conversation",
  ) {}

  private getApiKey(): string {
    const apiKey = this.config.get<string>("OPENROUTER_API_KEY");
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set — cannot make an OpenRouter LLM call.",
      );
    }
    return apiKey;
  }

  private getBaseUrl(): string {
    return this.config.get<string>(
      "OPENROUTER_API_BASE",
      "https://openrouter.ai/api/v1",
    );
  }

  private getModel(): string {
    const envKey =
      this.role === "classifier" ? "OPENROUTER_FAST_MODEL" : "OPENROUTER_MODEL";
    const fallback =
      this.role === "classifier"
        ? "meta-llama/llama-3.2-3b-instruct:free"
        : "meta-llama/llama-3.3-70b-instruct:free";
    return this.config.get<string>(envKey, fallback);
  }

  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const model = this.getModel();

    // OpenAI chat format keeps system messages inline in `messages` — no
    // separate top-level `system` field like Anthropic's.
    const messages = params.messages.map((m: LlmMessage) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens ?? 1024,
    };
    if (params.tool) {
      body.tools = [
        {
          type: "function",
          function: {
            name: params.tool.name,
            description: params.tool.description,
            parameters: params.tool.schema,
          },
        },
      ];
      body.tool_choice = "auto";
    }

    const start = Date.now();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional but recommended by OpenRouter for attributing usage on their dashboard.
        "HTTP-Referer": "https://github.com/kedu",
        "X-Title": "Kedu",
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - start;
    const json = (await res.json()) as OpenRouterResponse;

    if (!res.ok || json.error) {
      const message = json.error?.message ?? res.statusText;
      throw new Error(`OpenRouter ${params.purpose} call failed: ${message}`);
    }

    const choice = json.choices?.[0];
    const toolCall = choice?.message.tool_calls?.[0];

    this.logger.debug(
      `${params.purpose} call completed in ${latencyMs}ms via ${model}` +
        (json.usage
          ? ` (${json.usage.prompt_tokens}in/${json.usage.completion_tokens}out)`
          : ""),
    );

    return {
      text: choice?.message.content ?? undefined,
      toolCall: toolCall
        ? {
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments) as T,
          }
        : undefined,
      raw: json,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
          }
        : undefined,
      latencyMs,
      provider: "openrouter",
      model: json.model ?? model,
    };
  }
}
