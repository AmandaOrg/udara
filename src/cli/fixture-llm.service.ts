/**
 * Fixture LLM — returns a forced propose_turn tool call from loaded JSON.
 * Used by the dry-run CLI so agent paths can be tested without a live provider.
 */

import { Injectable } from "@nestjs/common";
import {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmService,
} from "../ai/llm.types";
import { ProposedTurn } from "../orchestrator/orchestrator.types";

@Injectable()
export class FixtureLlmService implements LlmService {
  private fixture: ProposedTurn | null = null;

  setFixture(proposal: ProposedTurn) {
    this.fixture = proposal;
  }

  getFixture(): ProposedTurn | null {
    return this.fixture;
  }

  async complete<T = unknown>(
    params: LlmCompleteParams,
  ): Promise<LlmCompleteResult<T>> {
    if (!this.fixture) {
      throw new Error(
        "FixtureLlmService has no fixture loaded — pass --fixture path.json",
      );
    }

    return {
      toolCall: {
        name: params.tool?.name ?? "propose_turn",
        arguments: this.fixture as T,
      },
      raw: { fixture: true, purpose: params.purpose },
      latencyMs: 0,
      provider: "fixture",
      model: "fixture",
    };
  }
}
