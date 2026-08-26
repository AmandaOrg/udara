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

/**
 * Raw output from the LLM's `propose_turn` tool call, before validation.
 */
export interface ProposedTurn {
  message: string;
  action: {
    type: 'reply_only' | 'show_surface';
    surface_key?: string;
    extracted_hints?: Record<string, unknown>;
    confidence?: 'high' | 'medium';
    reasoning?: string;
  };
}

/**
 * The validated result returned for dispatch.
 * If `ok` is false, ActionExecutor runs the failure SOP (apology + menu).
 */
export interface OrchestratorResult {
  /** Persona text to send to the user (ignored on failure — executor uses SOP copy). */
  message: string;
  /** If set, the executor dispatches this surface after sending the message. */
  surfaceKey?: string;
  /** Pre-fill hints for the surface (validated; transfer_wizard fields today). */
  extractedHints?: TransferWizardHints;
  /** When false, executor runs apology + spending_menu instead of the proposal. */
  ok?: boolean;
}

export const ORCHESTRATOR_LLM_TIMEOUT_MS = 4000;

export const ORCHESTRATOR_FAILURE_MESSAGE =
  "hmm, give me a sec — something glitched on my end. here's the menu in the meantime:";
