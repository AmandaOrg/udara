import { LlmCallPurpose } from "@prisma/client";

export type { LlmCallPurpose };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  /** A JSON Schema object (the `input_schema`/`parameters` shape each provider expects). */
  schema: Record<string, unknown>;
}

export interface LlmCompleteParams {
  messages: LlmMessage[];
  /** Set to request structured output via this tool. Unset means "free-text persona reply." */
  tool?: JsonSchemaToolDef;
  temperature?: number;
  maxTokens?: number;
  purpose: LlmCallPurpose;
  userId?: string;
}

export interface LlmCompleteResult<T = unknown> {
  /** The persona reply, present when the model didn't make a tool call. */
  text?: string;
  /** The raw, unvalidated proposal — never written to the DB without going through ExtractionValidatorService. */
  toolCall?: { name: string; arguments: T };
  raw: unknown;
  usage?: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  provider: string;
  model: string;
}

/**
 * Provider-agnostic contract — see AiModule for how a concrete provider
 * (Anthropic, a stub, or something else later) gets selected via AI_PROVIDER.
 * Two DI tokens (CLASSIFIER_LLM, CONVERSATION_LLM) both resolve to this
 * interface, mapping onto the classification-vs-conversation model split
 * from .env.example.
 */
export interface LlmService {
  complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>>;
}

export const CLASSIFIER_LLM = "CLASSIFIER_LLM";
export const CONVERSATION_LLM = "CONVERSATION_LLM";
