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
  /**
   * When true (only meaningful alongside `tool`), the provider must request
   * a genuine forced tool call — not "auto," where the model is free to
   * reply in text instead. Use this for closed-set classification (e.g.
   * IntentRouterService) where "the model decided to just talk instead of
   * calling the tool" is exactly the failure mode being guarded against, not
   * a plausible valid outcome. Extraction call sites (onboarding) should
   * keep this unset — "auto" is correct there, since free text IS a valid
   * outcome (the model pushing back on a vague answer).
   */
  forceTool?: boolean;
  temperature?: number;
  maxTokens?: number;
  purpose: LlmCallPurpose;
  userId?: string;
  /** Abort the HTTP call after this many ms (Bedrock/OpenRouter). */
  timeoutMs?: number;
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
