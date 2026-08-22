import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmMessage,
  LlmService,
} from "../llm.types";

type JsonSchemaLike = Record<string, unknown>;

const GEMINI_TYPE_MAP: Record<string, string> = {
  object: "OBJECT",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
};

/**
 * Gemini's function-calling schema is a constrained OpenAPI-3.0 subset that
 * expects uppercase Type-enum strings ("OBJECT", "STRING", ...) and doesn't
 * support JSON-Schema-only keys like additionalProperties/$schema/const —
 * this walks our provider-agnostic JSON Schema (written for Anthropic's
 * input_schema shape) and keeps only what Gemini actually accepts, dropping
 * the rest rather than risking a 400 on an unrecognized field.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  const input = schema as JsonSchemaLike;
  const output: JsonSchemaLike = {};

  if (typeof input.type === "string") {
    output.type =
      GEMINI_TYPE_MAP[input.type.toLowerCase()] ?? input.type.toUpperCase();
  }
  if (typeof input.description === "string") {
    output.description = input.description;
  }
  if (Array.isArray(input.enum)) output.enum = input.enum;
  if (typeof input.format === "string") output.format = input.format;
  if (Array.isArray(input.required)) output.required = input.required;
  if (input.properties && typeof input.properties === "object") {
    output.properties = Object.fromEntries(
      Object.entries(input.properties as JsonSchemaLike).map(([key, value]) => [
        key,
        toGeminiSchema(value),
      ]),
    );
  }
  if (input.items) output.items = toGeminiSchema(input.items);

  return output;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
}

interface GeminiCandidate {
  content?: { role: string; parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
  modelVersion?: string;
  error?: { message: string; code?: number; status?: string };
}

/**
 * Google Gemini implementation, called directly against the native
 * generateContent REST API (not the OpenAI-compatibility shim) so function
 * calling uses Gemini's real schema shape rather than a translation layer.
 * Same DI shape as the other providers — see ai.module.ts. One shared
 * GOOGLE_API_KEY covers both roles (Gemini doesn't key auth per-model);
 * GEMINI_FAST_MODEL is used for the classifier role, GEMINI_MODEL for the
 * conversation role, mirroring the OPENROUTER_FAST_MODEL/OPENROUTER_MODEL
 * split in the OpenRouter provider.
 *
 * Gemini has no "system" role in `contents` — system messages are collected
 * into the separate top-level `systemInstruction` field instead, and
 * assistant turns use role "model" rather than "assistant".
 *
 * Structured output uses Gemini's function calling: when params.tool is set,
 * toolConfig defaults to `mode: "AUTO"` — the model may call it or just
 * reply in text. When params.forceTool is also set, mode becomes "ANY"
 * (restricted to this one function via allowedFunctionNames) — a genuinely
 * forced call, for closed-set classification callers (IntentRouterService).
 */
export class GeminiLlmService implements LlmService {
  private readonly logger = new Logger(`GeminiLlmService(${this.role})`);

  constructor(
    private readonly config: ConfigService,
    private readonly role: "classifier" | "conversation",
  ) {}

  private getApiKey(): string {
    const apiKey = this.config.get<string>("GOOGLE_API_KEY");
    if (!apiKey) {
      throw new Error(
        "GOOGLE_API_KEY is not set — cannot make a Gemini LLM call.",
      );
    }
    return apiKey;
  }

  private getModel(): string {
    const envKey =
      this.role === "classifier" ? "GEMINI_FAST_MODEL" : "GEMINI_MODEL";
    return this.config.get<string>(envKey, "gemini-2.5-flash-lite");
  }

  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    const apiKey = this.getApiKey();
    const model = this.getModel();

    const systemText = params.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = params.messages
      .filter(
        (m): m is LlmMessage & { role: "user" | "assistant" } =>
          m.role !== "system",
      )
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxTokens ?? 1024,
      },
    };
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }
    if (params.tool) {
      body.tools = [
        {
          functionDeclarations: [
            {
              name: params.tool.name,
              description: params.tool.description,
              parameters: toGeminiSchema(params.tool.schema),
            },
          ],
        },
      ];
      body.toolConfig = params.forceTool
        ? {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: [params.tool.name],
            },
          }
        : { functionCallingConfig: { mode: "AUTO" } };
    }

    const start = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const latencyMs = Date.now() - start;
    const json = (await res.json()) as GeminiResponse;

    if (!res.ok || json.error) {
      const message = json.error?.message ?? res.statusText;
      throw new Error(`Gemini ${params.purpose} call failed: ${message}`);
    }

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);
    const textPart = parts.find((p) => typeof p.text === "string");

    this.logger.debug(
      `${params.purpose} call completed in ${latencyMs}ms via ${model}` +
        (json.usageMetadata
          ? ` (${json.usageMetadata.promptTokenCount}in/${json.usageMetadata.candidatesTokenCount}out)`
          : ""),
    );

    return {
      text: textPart?.text,
      toolCall: functionCallPart?.functionCall
        ? {
            name: functionCallPart.functionCall.name,
            arguments: functionCallPart.functionCall.args as T,
          }
        : undefined,
      raw: json,
      usage: json.usageMetadata
        ? {
            promptTokens: json.usageMetadata.promptTokenCount,
            completionTokens: json.usageMetadata.candidatesTokenCount,
          }
        : undefined,
      latencyMs,
      provider: "gemini",
      model: json.modelVersion ?? model,
    };
  }
}
