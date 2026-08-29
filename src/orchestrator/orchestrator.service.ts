/**
 * The AI Orchestrator — single LLM brain for post-onboarding free text.
 * On every free-text turn:
 *
 *   1. Loads conversation session + live facts (including active transfer mode)
 *   2. Prunes the surface registry to only eligible surfaces
 *   3. Calls the LLM with propose_turn (forced tool call)
 *   4. Validates the proposal (ActionValidatorService)
 *   5. Returns a validated OrchestratorResult for ActionExecutor
 *
 * The executor handles sending the message and dispatching the surface.
 * The orchestrator never calls WhatsApp APIs or financial services directly.
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CONVERSATION_LLM, LlmMessage, LlmService } from "../ai/llm.types";
import { LlmCallLoggerService } from "../ai/llm-call-logger.service";
import { AllowanceService } from "../allowance/allowance.service";
import { WindowService } from "../allowance/window.service";
import { ActionValidatorService } from "./action-validator.service";
import {
  buildOrchestratorSystemMessage,
  PROPOSE_TURN_TOOL,
} from "./prompts/orchestrator-system.prompt";
import { getEligibleSurfaces } from "./surface-registry";
import {
  ProposedTurn,
  OrchestratorResult,
  ORCHESTRATOR_LLM_TIMEOUT_MS,
  ORCHESTRATOR_PARSE_RETRY_TIMEOUT_MS,
  ProposeActionType,
} from "./orchestrator.types";
import { parseToolCallArguments } from "../ai/parse-tool-arguments.util";
import {
  formatWatCalendarDate,
  formatWatClockTime,
} from "../common/wat-time.util";
import {
  ConversationPersona,
  ConversationSession,
  ConversationSessionStatus,
  LlmCallPurpose,
  Prisma,
  TransactionStatus,
  TransferDraftStatus,
  User,
} from "@prisma/client";
import {
  isSpendCheckAbortUtterance,
  isWeakSpendCheckMessage,
  sanitizeTransferHints,
  shouldPauseForSpendCheck,
  SPEND_CHECK_FALLBACK_MESSAGE,
  transferHintsFromContext,
  transferHintsToRaw,
  TransferWizardHints,
} from "./transfer-hints.util";

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "reply_only",
  "show_surface",
  "fill_wizard",
  "cancel_surface",
]);

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONVERSATION_LLM) private readonly llm: LlmService,
    private readonly llmLogger: LlmCallLoggerService,
    private readonly allowance: AllowanceService,
    private readonly windowService: WindowService,
    private readonly validator: ActionValidatorService,
  ) {}

  /**
   * Main entry point — called by the router for post-onboarding free text
   * (including mid-wizard replies). Returns a validated result; ActionExecutor
   * handles sending and surface dispatch. On failure, returns `{ ok: false }`
   * — never throws.
   */
  async handleMessage(user: User, text: string): Promise<OrchestratorResult> {
    const session = await this.getOrCreateSession(user.id);
    const spendCheckPending = this.isSpendCheckPending(session);
    const storedHints = spendCheckPending
      ? transferHintsFromContext(this.sessionContext(session).spendCheck)
      : {};
    const history = await this.appendAndBuildHistory(session, "user", text);
    const liveFacts = await this.buildLiveFacts(
      user,
      spendCheckPending ? storedHints : null,
    );
    const eligibleSurfaces = getEligibleSurfaces(user);

    let logId: string | undefined;

    try {
      const llmParams = {
        messages: [
          buildOrchestratorSystemMessage(liveFacts, eligibleSurfaces, user),
          ...history,
        ],
        tool: PROPOSE_TURN_TOOL,
        forceTool: true as const,
        purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
        userId: user.id,
        maxTokens: 512,
        temperature: 0,
        timeoutMs: ORCHESTRATOR_LLM_TIMEOUT_MS,
      };

      let result = await this.withTimeout(
        this.llm.complete<ProposedTurn>(llmParams),
        ORCHESTRATOR_LLM_TIMEOUT_MS + 500,
      );

      let log = await this.llmLogger.log({
        userId: user.id,
        purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
        result,
      });
      logId = log.id;

      let proposal = this.parseProposal(result);
      // Retry only a fast malformed tool call — don't double-wait after a slow miss.
      if (!proposal && result.latencyMs < 5_000) {
        this.logger.warn(
          `Orchestrator parse_failed for user ${user.id} — retrying once`,
        );
        result = await this.withTimeout(
          this.llm.complete<ProposedTurn>({
            ...llmParams,
            timeoutMs: ORCHESTRATOR_PARSE_RETRY_TIMEOUT_MS,
          }),
          ORCHESTRATOR_PARSE_RETRY_TIMEOUT_MS + 500,
        );
        log = await this.llmLogger.log({
          userId: user.id,
          purpose: LlmCallPurpose.ORCHESTRATOR_TURN,
          result,
        });
        logId = log.id;
        proposal = this.parseProposal(result);
      }

      if (!proposal) {
        if (logId) {
          await this.llmLogger.markApplied(
            logId,
            {
              proposed: result.toolCall?.arguments ?? null,
              validated: null,
              rejectionReason: "parse_failed",
            },
            false,
          );
        }
        return this.failureResult();
      }

      if (spendCheckPending) {
        const incoming = sanitizeTransferHints(proposal.action.extracted_hints);
        proposal = {
          ...proposal,
          action: {
            ...proposal.action,
            extracted_hints: transferHintsToRaw({
              ...storedHints,
              ...incoming,
            }),
          },
        };
      }

      let validated = this.validator.validate(
        proposal,
        user,
        eligibleSurfaces,
        text,
        { spendCheckPending },
      );

      validated = await this.applySpendCheckSession(
        session.id,
        text,
        validated,
        sanitizeTransferHints(proposal.action.extracted_hints),
        spendCheckPending,
      );

      const launchedSurface =
        validated.actionType === "show_surface" && !!validated.surfaceKey;
      const sideEffect =
        validated.actionType === "fill_wizard" ||
        validated.actionType === "cancel_surface" ||
        launchedSurface;
      const rejectionReason =
        (proposal.action.type === "show_surface" ||
          proposal.action.type === "fill_wizard" ||
          proposal.action.type === "cancel_surface") &&
        !sideEffect
          ? proposal.action.confidence === "high"
            ? "surface_ineligible_or_missing_key"
            : "confidence_not_high"
          : undefined;

      await this.llmLogger.markApplied(
        logId,
        {
          proposed: proposal,
          validated: {
            message: validated.message,
            actionType: validated.actionType ?? null,
            surfaceKey: validated.surfaceKey ?? null,
            extractedHints: validated.extractedHints ?? null,
          },
          rejectionReason: rejectionReason ?? null,
        },
        true,
      );

      this.logger.debug(
        `Orchestrator: user=${user.id} ` +
          `proposed=${proposal.action.type}:${proposal.action.surface_key ?? "none"} ` +
          `validated=${validated.actionType ?? "reply_only"}:${validated.surfaceKey ?? "none"} ` +
          `confidence=${proposal.action.confidence ?? "missing→medium"} ` +
          `reason="${proposal.action.reasoning ?? ""}"`,
      );

      await this.appendMessage(session.id, "assistant", validated.message);
      return validated;
    } catch (err) {
      this.logger.error(
        `Orchestrator failed for user ${user.id}: ${String(err)}`,
      );
      if (logId) {
        await this.llmLogger
          .markApplied(
            logId,
            {
              proposed: null,
              validated: null,
              rejectionReason: "exception_or_timeout",
            },
            false,
          )
          .catch(() => undefined);
      }
      return this.failureResult();
    }
  }

  private failureResult(): OrchestratorResult {
    return {
      message: "",
      ok: false,
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Orchestrator LLM timed out after ${ms}ms`)),
        ms,
      );
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private parseProposal(result: {
    toolCall?: { arguments: unknown };
    text?: string;
  }): ProposedTurn | null {
    const a =
      parseToolCallArguments(result.toolCall?.arguments) ??
      parseToolCallArguments(result.text);
    if (!a) return null;

    const actionRaw =
      a.action && typeof a.action === "object" && !Array.isArray(a.action)
        ? (a.action as Record<string, unknown>)
        : typeof a.type === "string"
          ? a
          : undefined;
    if (!actionRaw || typeof actionRaw.type !== "string") return null;

    const message =
      typeof a.message === "string" && a.message.trim()
        ? a.message.trim().slice(0, 500)
        : "on it.";

    if (!ACTION_TYPES.has(actionRaw.type)) {
      return null;
    }

    return {
      message,
      action: {
        type: actionRaw.type as ProposeActionType,
        surface_key:
          typeof actionRaw.surface_key === "string"
            ? actionRaw.surface_key
            : undefined,
        extracted_hints:
          actionRaw.extracted_hints &&
          typeof actionRaw.extracted_hints === "object"
            ? (actionRaw.extracted_hints as Record<string, unknown>)
            : undefined,
        confidence:
          actionRaw.confidence === "high" || actionRaw.confidence === "medium"
            ? actionRaw.confidence
            : undefined,
        reasoning:
          typeof actionRaw.reasoning === "string"
            ? actionRaw.reasoning
            : undefined,
      },
    };
  }

  private async buildLiveFacts(
    user: User,
    spendCheck: TransferWizardHints | null,
  ): Promise<string> {
    const now = new Date();
    const lines = [
      "Live facts, computed just now. These are real values, not estimates. Use these exact numbers and never guess or substitute your own:",
      `- Current date: ${formatWatCalendarDate(now)} (WAT)`,
      `- Current time: ${formatWatClockTime(now)} WAT`,
      `- Spending window: ${user.windowStartHour}:00 to ${user.windowEndHour}:00 WAT`,
    ];

    const [draft, pending, lastSent, allowanceSummary] = await Promise.all([
      this.prisma.transferDraft.findFirst({
        where: { userId: user.id, status: TransferDraftStatus.ACTIVE },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.transaction.findFirst({
        where: {
          userId: user.id,
          status: {
            in: [
              TransactionStatus.PENDING_CONFIRMATION,
              TransactionStatus.PENDING_PIN,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.transaction.findFirst({
        where: {
          userId: user.id,
          status: TransactionStatus.EXECUTED,
        },
        orderBy: { executedAt: "desc" },
        include: { recipient: true },
      }),
      this.allowance.getRemainingSummary(user.id).catch((err: unknown) => {
        this.logger.warn(
          `Could not load allowance for user ${user.id}: ${String(err)}`,
        );
        return null;
      }),
    ]);
    const pendingConfirm = pending;
    const staleDraft =
      !!draft &&
      !!lastSent?.executedAt &&
      !!draft.createdAt &&
      new Date(lastSent.executedAt).getTime() >=
        new Date(draft.createdAt).getTime();
    if (staleDraft && draft) {
      void this.prisma.transferDraft
        .updateMany({
          where: { id: draft.id, status: TransferDraftStatus.ACTIVE },
          data: { status: TransferDraftStatus.CANCELLED },
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `Could not cancel stale draft ${draft.id}: ${String(err)}`,
          );
        });
    }
    const activeDraft = staleDraft ? null : draft;

    if (pendingConfirm) {
      const waitingOnPin =
        pendingConfirm.status === TransactionStatus.PENDING_PIN;
      lines.push(
        `- Active mode: awaiting_confirm`,
        `- Pending ${waitingOnPin ? "PIN" : "confirm"}: amount ₦${Number(pendingConfirm.amount).toLocaleString("en-NG")} (do NOT start transfer_wizard. ${waitingOnPin ? "They must enter PIN." : "Remind them to tap Confirm or Cancel."})`,
      );
    } else if (activeDraft) {
      lines.push(
        "- Active mode: transfer_wizard",
        `- Draft step: ${activeDraft.step}`,
        `- Draft amount: ${activeDraft.amount != null ? `₦${Number(activeDraft.amount).toLocaleString("en-NG")}` : "missing"}`,
        `- Draft account: ${activeDraft.accountNumber ?? "missing"}`,
        `- Draft bank: ${activeDraft.bankName ?? activeDraft.bankCode ?? "missing"}`,
        "- If the user is answering a missing field, use fill_wizard with extracted_hints. If they change topic, use cancel_surface or show_surface for the new intent.",
      );
    } else if (spendCheck) {
      const raw = transferHintsToRaw(spendCheck);
      lines.push(
        "- Active mode: spend_check",
        `- Pending send hints: amount=${raw.amount ?? "missing"}, account=${raw.account_number ?? "missing"}, bank=${raw.bank_name ?? raw.bank_code ?? "missing"}`,
        "- Remaining allowance is not permission to skip this. Ask (or keep asking) what the send is for unless they already answered.",
        "- If they gave a purpose, insisted, or still want to send → show_surface transfer_wizard with extracted_hints this turn. If they backed off → reply_only.",
      );
    } else {
      lines.push("- Active mode: free");
    }

    if (lastSent) {
      const who =
        lastSent.recipient?.accountName ??
        lastSent.recipient?.accountNumber ??
        "recipient";
      lines.push(
        `- Last completed transfer: ₦${Number(lastSent.amount).toLocaleString("en-NG")} to ${who}. This already succeeded. Thanks or "you already sent it" → reply_only, do NOT start transfer_wizard again.`,
      );
    }

    if (user.disciplineExitedAt) {
      lines.push(
        "- Restrictions: OFF. Spending window and override fees do not apply.",
      );
    } else if (
      this.windowService.isWithinWindow(
        user.windowStartHour,
        user.windowEndHour,
        now,
      )
    ) {
      lines.push(`- Window: OPEN, closes at ${user.windowEndHour}:00 WAT.`);
    } else {
      const hoursUntil = this.windowService.hoursUntilWindowOpens(
        user.windowStartHour,
        now,
      );
      lines.push(
        `- Window: CLOSED, reopens at ${user.windowStartHour}:00 WAT (~${hoursUntil}h). No transfers until then.`,
      );
    }

    if (allowanceSummary) {
      const { remainingToday, remainingWeek } = allowanceSummary;
      lines.push(
        `- Remaining allowance today: ₦${remainingToday.toLocaleString("en-NG")} (budget cap, not wallet balance)`,
        `- Remaining allowance this week: ₦${remainingWeek.toLocaleString("en-NG")}`,
      );
    } else {
      lines.push(
        "- Allowance figures unavailable this turn. If asked, say you can't pull it up right now. Do NOT estimate.",
      );
    }

    return lines.join("\n");
  }

  private sessionContext(
    session: ConversationSession,
  ): Record<string, unknown> {
    const raw = session.contextData;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  }

  private isSpendCheckPending(session: ConversationSession): boolean {
    const ctx = this.sessionContext(session);
    return ctx.spendCheck != null && typeof ctx.spendCheck === "object";
  }

  private async writeSpendCheck(
    sessionId: string,
    spendCheck: TransferWizardHints | null,
  ): Promise<void> {
    const session = await this.prisma.conversationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const ctx = this.sessionContext(session);
    if (spendCheck == null) {
      delete ctx.spendCheck;
    } else {
      ctx.spendCheck = spendCheck;
    }
    await this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { contextData: ctx as Prisma.InputJsonValue },
    });
  }

  /**
   * Persist or clear the spend-check beat so a vague first send cannot skip
   * coaching, and a later "it's for food" can still open the wizard.
   */
  private async applySpendCheckSession(
    sessionId: string,
    userText: string,
    validated: OrchestratorResult,
    hints: TransferWizardHints,
    wasPending: boolean,
  ): Promise<OrchestratorResult> {
    const launchedWizard =
      validated.actionType === "show_surface" &&
      validated.surfaceKey === "transfer_wizard";
    const topicChange =
      validated.actionType === "cancel_surface" ||
      (validated.actionType === "show_surface" &&
        validated.surfaceKey !== "transfer_wizard");

    if (isSpendCheckAbortUtterance(userText) || launchedWizard || topicChange) {
      if (wasPending || launchedWizard) {
        await this.writeSpendCheck(sessionId, null);
      }
      return validated;
    }

    const paused =
      validated.actionType === "reply_only" &&
      shouldPauseForSpendCheck(userText, hints);

    if (paused) {
      await this.writeSpendCheck(sessionId, hints);
      if (isWeakSpendCheckMessage(validated.message)) {
        return { ...validated, message: SPEND_CHECK_FALLBACK_MESSAGE };
      }
      return validated;
    }

    return validated;
  }

  private async getOrCreateSession(
    userId: string,
  ): Promise<ConversationSession> {
    const existing = await this.prisma.conversationSession.findFirst({
      where: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (existing) return existing;

    return this.prisma.conversationSession.create({
      data: {
        userId,
        persona: ConversationPersona.KEDU,
        status: ConversationSessionStatus.ACTIVE,
        messages: [],
      },
    });
  }

  private async appendMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ) {
    const session = await this.prisma.conversationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const messages = Array.isArray(session.messages) ? session.messages : [];
    messages.push({ role, content, at: new Date().toISOString() });
    return this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { messages: messages as Prisma.InputJsonValue },
    });
  }

  private async appendAndBuildHistory(
    session: ConversationSession,
    role: "user" | "assistant",
    content: string,
  ): Promise<LlmMessage[]> {
    const updated = await this.appendMessage(session.id, role, content);
    const messages = Array.isArray(updated.messages) ? updated.messages : [];
    return messages.slice(-12).map((raw) => {
      const m = raw as { role?: string; content?: string };
      return {
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
      } as LlmMessage;
    });
  }
}
