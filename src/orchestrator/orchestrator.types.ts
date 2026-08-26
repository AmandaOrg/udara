/**
 * Types for the AI Orchestrator — the single LLM brain that decides
 * what to say and which UI surface to present on every conversational turn.
 *
 * The orchestrator proposes; the validator decides whether to execute.
 * The ActionExecutor dispatches the validated result.
 */

import { TransferWizardHints } from './transfer-hints.util';

export type SurfaceKind =
  | 'text'
  | 'list'
  | 'buttons'
  | 'whatsapp_flow'
  | 'wizard';

export type ActiveMode = 'free' | 'transfer_wizard' | 'awaiting_confirm';

export type ProposeActionType =
  | 'reply_only'
  | 'show_surface'
  | 'fill_wizard'
  | 'cancel_surface';

/**
 * Raw output from the LLM's `propose_turn` tool call, before validation.
 */
export interface ProposedTurn {
  message: string;
  action: {
    type: ProposeActionType;
    surface_key?: string;
    extracted_hints?: Record<string, unknown>;
    confidence?: 'high' | 'medium';
    reasoning?: string;
  };
}

/**
 * The validated result returned for dispatch.
 * If `ok` is false, ActionExecutor runs the failure SOP (apology only).
 */
export interface OrchestratorResult {
  /** Persona text to send to the user (ignored on failure — executor uses SOP copy). */
  message: string;
  /** Action the executor should take after sending the message. */
  actionType?: ProposeActionType;
  /** If set, the executor dispatches this surface after sending the message. */
  surfaceKey?: string;
  /** Pre-fill / fill hints for the surface (validated; transfer_wizard fields). */
  extractedHints?: TransferWizardHints;
  /** When false, executor runs soft apology instead of the proposal. */
  ok?: boolean;
}

/**
 * Bedrock/tool-call turns routinely take longer than 4s. The webhook is
 * already ACK'd. 25s stays inside WhatsApp's typing window so a slow Kimi
 * call is not reported as "I missed that".
 */
export const ORCHESTRATOR_LLM_TIMEOUT_MS = 25_000;
export const ORCHESTRATOR_PARSE_RETRY_TIMEOUT_MS = 10_000;

export const ORCHESTRATOR_FAILURE_MESSAGE =
  "sorry, I missed that — try saying it one more time?";
