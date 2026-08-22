import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmService,
  LlmMessage,
} from "../llm.types";

/**
 * Real Anthropic implementation. Two instances are built by AiModule's
 * factory (one per DI token) with different model/API-key env var names —
 * see ai.module.ts for why this isn't a plain @Injectable() class.
 *
 * Structured output uses Anthropic's tool-use: when params.tool is set, the
 * tool is offered with tool_choice: 'auto' by default — the model calls it
 * only when it has enough to fill the schema confidently, and replies in
 * free text otherwise. That presence/absence of a tool_use block on the
 * response *is* the "is this answer usable" signal (see llm.types.ts) — not
 * an extra self-reported field the model could get wrong. When
 * params.forceTool is also set, tool_choice becomes `{ type: "tool", name }`
 * instead — a genuinely forced call, for closed-set classification callers
 * (IntentRouterService) where "replied in text instead" isn't a valid outcome.
 */
export class AnthropicLlmService implements LlmService {
  private readonly logger = new Logger(`AnthropicLlmService(${this.role})`);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly role: "classifier" | "conversation",
    private readonly modelEnvKey: string,
    private readonly apiKeyEnvKey: string,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.config.get<string>(this.apiKeyEnvKey);
      if (!apiKey) {
        throw new Error(
          `${this.apiKeyEnvKey} is not set — cannot make a ${this.role} LLM call.`,
        );
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    const client = this.getClient();
    const model = this.config.get<string>(this.modelEnvKey, "claude-sonnet-5");

    const system = params.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const conversation = params.messages
      .filter(
        (m): m is LlmMessage & { role: "user" | "assistant" } =>
          m.role !== "system",
      )
      .map((m) => ({ role: m.role, content: m.content }));

    const start = Date.now();
    const response = await client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature,
      system: system || undefined,
      messages: conversation,
      tools: params.tool
        ? [
            {
              name: params.tool.name,
              description: params.tool.description,
              input_schema: params.tool.schema as Anthropic.Tool.InputSchema,
            },
          ]
        : undefined,
      tool_choice: params.tool
        ? params.forceTool
          ? { type: "tool", name: params.tool.name }
          : { type: "auto" }
        : undefined,
    });
    const latencyMs = Date.now() - start;

    const toolUseBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );

    this.logger.debug(
      `${params.purpose} call completed in ${latencyMs}ms (${response.usage.input_tokens}in/${response.usage.output_tokens}out)`,
    );

    return {
      text: textBlock?.text,
      toolCall: toolUseBlock
        ? { name: toolUseBlock.name, arguments: toolUseBlock.input as T }
        : undefined,
      raw: response,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
      latencyMs,
      provider: "anthropic",
      model,
    };
  }
}
