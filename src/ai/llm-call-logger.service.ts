import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LlmCompleteResult } from "./llm.types";
import { LlmCallPurpose, Prisma } from "@prisma/client";

const REDACTED_KEYS = ["bvn", "nin", "dateOfBirth", "email"];

/**
 * The AI audit trail — "every output is a proposal, never a command" made
 * concrete: every LlmService.complete() call gets logged here, the raw
 * proposal kept distinct from validationResult/appliedToUser (attached
 * after the fact by the caller once ExtractionValidatorService has run).
 * Sensitive fields are redacted before persisting even though they'd only
 * appear here if a prompt echoed them back — cheap insurance.
 */
@Injectable()
export class LlmCallLoggerService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    userId?: string;
    purpose: LlmCallPurpose;
    result: LlmCompleteResult;
  }) {
    return this.prisma.llmCallLog.create({
      data: {
        userId: params.userId,
        purpose: params.purpose,
        provider: params.result.provider,
        model: params.result.model,
        promptTokens: params.result.usage?.promptTokens,
        completionTokens: params.result.usage?.completionTokens,
        latencyMs: params.result.latencyMs,
        rawResponse: redact(
          params.result.toolCall ?? params.result.text ?? {},
        ) as Prisma.InputJsonValue,
      },
    });
  }

  async markApplied(
    logId: string,
    validationResult: unknown,
    appliedToUser: boolean,
  ) {
    return this.prisma.llmCallLog.update({
      where: { id: logId },
      data: {
        validationResult: validationResult as Prisma.InputJsonValue,
        appliedToUser,
      },
    });
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.includes(key) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return value;
}
