# Udara project summary

Last updated: 2026-08-28

Quick orientation for agents. Full behavior: `docs/PRODUCT_BEHAVIOR.md`. Full flow: `docs/ARCHITECTURE.md`. Working rules: `AGENTS.md`.

## 1. Product

WhatsApp savings agent on a Rubies wallet. Enforces WAT spending window, confirm-before-send, PIN via Flows, daily/weekly allowance with early-access/borrow fees. User-facing name **Udara**; npm package `kedu`.

## 2. Stack

NestJS 10, Prisma 5, PostgreSQL 16 (host port 5433), Jest (`src/**/*.spec.ts`), black-box `e2e/`, golden dialogues. Default HTTP 3000.

## 3. Modules

| Path | Role |
| --- | --- |
| `src/prisma` | Global PrismaService |
| `src/config` | Boot env validation |
| `src/allowance` | Window, fees, allowance, schedulers |
| `src/onboarding` | Stage machine |
| `src/tagging` | Recipient tags |
| `src/manager` | Settings-change gate + delayed persona |
| `src/rubies` | BaaS + inbound webhook |
| `src/ai` | LLM providers + persona prompts |
| `src/orchestrator` | propose_turn + validator + surfaces (no send) |
| `src/whatsapp` | Webhook, router, wizard, PIN gate, ActionExecutor |
| `src/pin` | PIN challenge/verify |
| `src/cli` | Dry-run golden/fixture runner |
| `src/common` | WAT, bank match, display name |

`AppModule` imports Prisma, config, schedule, Rubies, Allowance, Tagging, Onboarding, Manager, Whatsapp (last). AI + Orchestrator come in via WhatsappModule. Circular `forwardRef` with Allowance, Rubies, Onboarding, Manager.

## 4. Routing

Structured payloads → deterministic handlers. Pre-account text → onboarding. Menu shortcuts → list. Post-onboarding text → orchestrator.

Surfaces: `balance_read`, `limits_read`, `account_details`, `transfer_wizard`, `spending_menu`, `spend_summary`.

## 5. Data (Prisma)

User, DailyAllowance, Recipient (nickname, lastUsedAt), Transaction (purposeLabel), OverrideHistory, SettingsChangeRequest, onboarding/conversation sessions, TransferDraft, WhatsappMessage, PIN challenge, Rubies webhook log, LLM call log, nudges.

`TransferDraft` ≠ `ConversationSession`. Persona enum still `KEDU` | `MANAGER`. Session `contextData.spendCheck` holds pending send hints during the pre-wizard spend check.

## 6. Integrations

WhatsApp Cloud API (`WHATSAPP_DRY_RUN`), Rubies (`RUBIES_DRY_RUN`), LLM (`AI_PROVIDER=stub|anthropic|openrouter|gemini|bedrock`).

## 7. Commands

`start:dev`, `test`, `lint`, `e2e` / `e2e:smoke`, `orchestrator:golden`, `orchestrator:cli`, `docs:check`, `security:check`. CI: security:check, docs:check, lint, prisma generate/migrate, build, unit test. Not in CI: e2e, live LLM.

## 8. Docs map

| File | Use |
| --- | --- |
| `docs/SECURITY.md` | Mandatory gate: S1–S12 invariants + per-change checklist |
| `docs/README.md` | Index + founding PDFs (background only) |
| `docs/specs/` | Feature behavior |
| `docs/tech-design/` | Feature how |
| `docs/decisions/` | ADRs |
| `initiatives/` | Status |
| `e2e/README.md` | E2e contract |

## 9. Gotchas

- Postgres **5433**
- HMAC needs `rawBody: true`
- Unsigned webhooks only when secrets blank
- Stub AI does not emit `propose_turn` (e2e free text → failure SOP)
- Fee sweep skipped without `RUBIES_FEES_ACCOUNT_NUMBER`
- Founding PDFs (PRD, onboarding script, tone prompt) are in `docs/` but are stale background, not spec — code wins

## 10. Active initiatives

- `initiatives/spend-check-before-send` — vague sends get one coaching question before the wizard; purposeLabel on Transaction; remaining allowance is not a skip.
- `initiatives/transfer-intent-grounding` — closed-send utterances must not relaunch the wizard; completed sends are written into chat history.
- `initiatives/beneficiary-prefill` — completed; nickname prefill for repeat sends (confirm/PIN unchanged).
- `initiatives/bill-payments` — blocked on Rubies API spike (Phase A airtime pending confirmation).
