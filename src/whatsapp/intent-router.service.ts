import { Inject, Injectable, Logger } from "@nestjs/common";
import { CLASSIFIER_LLM, LlmService } from "../ai/llm.types";
import {
  ExtractionValidatorService,
  MenuIntent,
} from "../ai/extraction-validator.service";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import {
  MENU_INTENT_TOOL,
  buildMenuIntentSystemMessage,
} from "../ai/prompts/menu-intent.prompts";
import { LlmCallPurpose } from "@prisma/client";

/**
 * The classify-before-chat step (see whatsapp-router.service.ts's fallthrough
 * to KeduChatService) that stops free text whose intent is already covered
 * by the deterministic menu — balance/limits/account-details/transfer —
 * from ever reaching KeduChatService's ungrounded persona chat, which has no
 * account data and can otherwise hallucinate a plausible-looking answer
 * (e.g. a fake balance).
 *
 * Uses CLASSIFIER_LLM (the small/fast model, distinct from CONVERSATION_LLM)
 * with forceTool: true — a genuinely forced tool call, not "auto," since
 * "the model just replied in text instead of classifying" is exactly the
 * failure mode this exists to close off, not a valid outcome here (contrast
 * with onboarding's extraction calls, where free text IS a valid "pushing
 * back on a vague answer" outcome).
 *
 * Fails open, always: any error, missing tool call, or invalid value
 * resolves to "NONE" rather than throwing — same "best-effort, never block
 * the main flow" pattern as the fee sweep and typing indicator. A
 * classifier hiccup must degrade to today's normal-chat behavior, never
 * break the message pipeline.
 */
@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);

  constructor(
    @Inject(CLASSIFIER_LLM) private readonly llm: LlmService,
    private readonly validator: ExtractionValidatorService,
    private readonly llmLogger: LlmCallLoggerService,
  ) {}

  async classify(text: string, userId: string): Promise<MenuIntent> {
    try {
      const result = await this.llm.complete({
        messages: [
          buildMenuIntentSystemMessage(),
          { role: "user", content: text },
        ],
        tool: MENU_INTENT_TOOL,
        forceTool: true,
        purpose: LlmCallPurpose.INTENT_CLASSIFICATION,
        userId,
      });

      const log = await this.llmLogger.log({
        userId,
        purpose: LlmCallPurpose.INTENT_CLASSIFICATION,
        result,
      });

      if (!result.toolCall) {
        await this.llmLogger.markApplied(log.id, null, false);
        return "NONE";
      }

      const outcome = this.validator.validateMenuIntent(
        result.toolCall.arguments,
      );
      await this.llmLogger.markApplied(log.id, outcome, outcome.accepted);

      return outcome.accepted && outcome.cleanedValue
        ? outcome.cleanedValue
        : "NONE";
    } catch (err) {
      this.logger.warn(
        `Menu-intent classification failed for user ${userId}, falling back to NONE: ${String(err)}`,
      );
      return "NONE";
    }
  }
}
