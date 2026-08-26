import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmMessage,
  LlmService,
} from "../llm.types";
import { parseToolCallArguments } from "../parse-tool-arguments.util";

interface BedrockToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface BedrockChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: BedrockToolCall[];
  };
}

interface BedrockResponse {
  model: string;
  choices: BedrockChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string; code?: string | number };
}

const DEFAULT_MODEL = "moonshotai.kimi-k2.5";

/**
 * AWS Bedrock via the OpenAI-compatible Mantle endpoint — same shape as
 * OpenRouterLlmService (Bearer key + /chat/completions + function tools).
 * Env aliases match Amanda: BEDROCK_API_KEY | AWS_BEARER_TOKEN_BEDROCK |
 * OPENAI_API_KEY, and BEDROCK_BASE_URL | OPENAI_BASE_URL.
 * BEDROCK_FAST_MODEL → classifier; BEDROCK_MODEL → conversation.
 */
export class BedrockLlmService implements LlmService {
  private readonly logger = new Logger(`BedrockLlmService(${this.role})`);

  constructor(
    private readonly config: ConfigService,
    private readonly role: "classifier" | "conversation",
  ) {}

  private firstNonEmpty(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.config.get<string>(key)?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private getApiKey(): string {
    const apiKey = this.firstNonEmpty(
      "BEDROCK_API_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "OPENAI_API_KEY",
    );
    if (!apiKey) {
      throw new Error(
        "BEDROCK_API_KEY (or AWS_BEARER_TOKEN_BEDROCK / OPENAI_API_KEY) is not set — cannot make a Bedrock LLM call.",
      );
    }
    return apiKey;
  }

  private getBaseUrl(): string {
    const baseUrl = this.firstNonEmpty("BEDROCK_BASE_URL", "OPENAI_BASE_URL");
    if (!baseUrl) {
      throw new Error(
        "BEDROCK_BASE_URL (or OPENAI_BASE_URL) is not set — cannot make a Bedrock LLM call.",
      );
    }
    return baseUrl.replace(/\/$/, "");
  }

  private getModel(): string {
    const envKey =
      this.role === "classifier" ? "BEDROCK_FAST_MODEL" : "BEDROCK_MODEL";
    return this.config.get<string>(envKey, DEFAULT_MODEL);
  }

  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const model = this.getModel();

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
      body.tool_choice = params.forceTool
        ? { type: "function", function: { name: params.tool.name } }
        : "auto";
    }

    const start = Date.now();
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - start;
    const json = (await res.json()) as BedrockResponse;

    if (!res.ok || json.error) {
      const message = json.error?.message ?? res.statusText;
      throw new Error(`Bedrock ${params.purpose} call failed: ${message}`);
    }

    const choice = json.choices?.[0];
    const toolCall = choice?.message.tool_calls?.[0];
    const parsedArgs = toolCall
      ? parseToolCallArguments(toolCall.function.arguments)
      : undefined;

    this.logger.debug(
      `${params.purpose} call completed in ${latencyMs}ms via ${model}` +
        (json.usage
          ? ` (${json.usage.prompt_tokens}in/${json.usage.completion_tokens}out)`
          : ""),
    );

    return {
      text: choice?.message.content ?? undefined,
      toolCall:
        toolCall && parsedArgs
          ? {
              name: toolCall.function.name,
              arguments: parsedArgs as T,
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
      provider: "bedrock",
      model: json.model ?? model,
    };
  }
}
