import { Injectable } from "@nestjs/common";
import { LlmCompleteParams, LlmCompleteResult, LlmService } from "../llm.types";

/**
 * Deterministic fake — wired when AI_PROVIDER=stub (the default). Never
 * calls a real provider, never makes a tool call (so anything depending on
 * structured extraction correctly stays put rather than silently advancing
 * on fabricated data). Lets the whole pipeline run end-to-end in dev/tests
 * without a real API key — same philosophy as RubiesService's dry-run mode
 * and the WhatsApp/Rubies signature guards' dev-mode escape hatch.
 */
@Injectable()
export class StubLlmService implements LlmService {
  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    return {
      text:
        "[stub LLM — no AI_PROVIDER configured]\n\n" +
        "i heard you, but i can't give a real reply right now — no ai provider is wired up.",
      raw: { stub: true, purpose: params.purpose },
      latencyMs: 0,
      provider: "stub",
      model: "stub",
    };
  }
}
