/**
 * No-op LLM audit logger for CLI dry-run — never writes to Postgres.
 */

import { Injectable } from '@nestjs/common';
import { LlmCompleteResult } from '../ai/llm.types';
import { LlmCallPurpose } from '@prisma/client';

@Injectable()
export class CliNoopLlmLogger {
  private verbose = false;
  private seq = 0;

  setVerbose(verbose: boolean) {
    this.verbose = verbose;
  }

  async log(params: {
    userId?: string;
    purpose: LlmCallPurpose;
    result: LlmCompleteResult;
  }) {
    this.seq += 1;
    const id = `cli-log-${this.seq}`;
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.error(
        `[cli llm log] ${id} purpose=${params.purpose} provider=${params.result.provider} latencyMs=${params.result.latencyMs}`,
      );
    }
    return { id };
  }

  async markApplied(
    logId: string,
    validationResult: unknown,
    appliedToUser: boolean,
  ) {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.error(
        `[cli llm log] markApplied ${logId} applied=${appliedToUser}`,
        validationResult,
      );
    }
    return { id: logId };
  }
}
