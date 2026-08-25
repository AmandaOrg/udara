/**
 * Builds the orchestrator's system prompt on every turn. Token-budgeted:
 *
 *   Persona identity + voice    ~600 tok
 *   Orchestrator role            ~300 tok
 *   Eligible surfaces (pruned)   ~200 tok  ← not the full registry
 *   Live facts                   ~100 tok
 *   User state snapshot           ~80 tok
 *   Guardrails                   ~150 tok
 *   History (dynamic, last 10)   ~800 tok
 *   ─────────────────────────────────────
 *   Total system + context      ~2300 tok
 */

import { JsonSchemaToolDef, LlmMessage } from '../../ai/llm.types';
import {
  KEDU_IDENTITY_ANCHOR,
  KEDU_VOICE_RULES,
} from '../../ai/prompts/kedu-persona.prompts';
import {
  SurfaceDefinition,
  formatSurfacesForPrompt,
} from '../surface-registry';
import { User } from '@prisma/client';

// ─── Orchestrator role ──────────────────────────────────────────────

const ORCHESTRATOR_ROLE = `You are Udara's dialogue orchestrator. On every turn you MUST call the propose_turn tool — never reply in plain text.

Your job each turn:
1. Read the user's message, conversation history, and live facts below
2. Decide: just reply with text (reply_only) or reply with text AND launch a UI surface (show_surface)
3. Write the user-facing message in Udara's voice (see voice rules above)
4. Call propose_turn with your decision

Decision rules:
- Only propose surfaces listed in "Available surfaces" below. Never invent surface keys.
- For money questions (balance, limits, spending), ALWAYS use the matching surface so the user sees real data — never guess or remember numbers from earlier turns.
- For read surfaces (balance_read, limits_read, account_details, spend_summary): your message must be a short lead-in ONLY (e.g. "pulling that up now"). Do NOT restate balances, allowance figures, or account numbers in the message — the surface sends the real figures next.
- For transfers, use transfer_wizard — you cannot process transfers yourself.
- When type is show_surface, you MUST set confidence. Use "high" only when the intent is clear. Use "medium" when plausible but ambiguous — the system will send your text without launching the surface.
- If the user is chatting, venting, asking general questions, or the intent is ambiguous, use reply_only.`;

// ─── Guardrails ─────────────────────────────────────────────────────

const GUARDRAILS = `Hard guardrails — violations are blocked automatically:
- Never quote a balance, allowance amount, or account number from memory or earlier messages. Those come from live facts for YOUR reasoning only. In user-facing messages for read surfaces, do not paste the numbers — the surface owns them.
- Never trigger transfer_wizard just because money was mentioned in passing — only when the user is clearly asking to send money right now.
- Never trigger a surface that isn't listed in "Available surfaces" above.
- If live facts say the window is CLOSED, do not suggest the user can send money right now — they'll need to wait.
- You cannot execute transfers, check balances, or read account data yourself. You can only propose surfaces that do those things.
- show_surface requires confidence: "high" or "medium". Missing confidence is treated as medium (text only).`;

// ─── Tool definition ────────────────────────────────────────────────

export const PROPOSE_TURN_TOOL: JsonSchemaToolDef = {
  name: 'propose_turn',
  description:
    'Decide what to say and optionally which surface to show. You MUST call this tool every turn.',
  schema: {
    type: 'object',
    required: ['message', 'action'],
    properties: {
      message: {
        type: 'string',
        description:
          "Your reply in Udara's voice. Always required. Keep it natural and conversational. For read surfaces, short lead-in only — no numbers.",
      },
      action: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: ['reply_only', 'show_surface'],
            description:
              'reply_only: just send the message, no UI. show_surface: send message then launch a surface.',
          },
          surface_key: {
            type: 'string',
            description:
              'Required when type is show_surface. Must be one of the eligible surface keys listed in the system prompt.',
          },
          extracted_hints: {
            type: 'object',
            description:
              'Optional structured data extracted from the message to pre-fill the surface. Only include fields you are confident about.',
            properties: {
              amount: {
                type: 'number',
                description: 'Transfer amount in naira, if user mentioned one',
              },
              label_hint: {
                type: 'string',
                enum: ['RENT', 'FOOD', 'VENDOR', 'OTHER'],
                description:
                  'Recipient category hint if clearly stated. Stored for audit; wizard still confirms label.',
              },
            },
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium'],
            description:
              "Required for show_surface. Use 'high' only when intent is clear. Use 'medium' when ambiguous — system skips the surface.",
          },
          reasoning: {
            type: 'string',
            description:
              'One-sentence internal explanation for audit. Not shown to user.',
          },
        },
      },
    },
  },
};

// ─── System message builder ─────────────────────────────────────────

export function buildOrchestratorSystemMessage(
  liveFacts: string,
  eligibleSurfaces: SurfaceDefinition[],
  user: User,
): LlmMessage {
  const userState = [
    `Onboarding: ${user.onboardingStage}`,
    user.rubiesAccountNumber ? 'Account: active' : 'Account: none',
    user.name ? `Name: ${user.name}` : null,
    user.disciplineExitedAt
      ? 'Restrictions: exited'
      : 'Restrictions: active',
  ]
    .filter(Boolean)
    .join(' | ');

  return {
    role: 'system',
    content: [
      KEDU_IDENTITY_ANCHOR,
      KEDU_VOICE_RULES,
      ORCHESTRATOR_ROLE,
      formatSurfacesForPrompt(eligibleSurfaces),
      liveFacts,
      `User state: ${userState}`,
      GUARDRAILS,
    ].join('\n\n---\n\n'),
  };
}
