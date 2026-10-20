# Amanda project summary

Last updated: 2026-09-25

Quick orientation for agents. Full behavior: `docs/PRODUCT_BEHAVIOR.md`. Full flow: `docs/ARCHITECTURE.md`. Working rules: `AGENTS.md`.

## 1. Product

WhatsApp savings agent on a Rubies wallet. Enforces WAT spending window, confirm-before-send, PIN via Flows, daily/weekly allowance with early-access/borrow fees. User-facing name **Amanda**; npm package `kedu`.

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
| `src/account-closure` | Closing an account: kept vs erased (ADR-0003), from the ops CLI |
| `src/rubies` | BaaS + VAS purchase/query + inbound webhook |
| `src/ai` | LLM providers + persona prompts |
| `src/orchestrator` | propose_turn + validator + surfaces (no send) |
| `src/messaging` | `ChannelMessenger`: the only way to send; channel context; WhatsApp and app adapters; `AppMessage` store; delivery policy; Expo push |
| `src/conversation` | `ConversationRouterService` (routing for both channels), `TurnService` (per-user turn lease, channel-switch expiry) |
| `src/app-auth` | App sign-in: SMS codes (Termii), sessions, new-device step-up, new-device transfer cap |
| `src/app-api` | Mobile app `/v1` API (auth, me, chat, forms, devices, read-only screens, native transfers and bills, settings requests, email check, terms, closure requests), deny-by-default guard; only with `APP_API_ENABLED=true`; OpenAPI at `/docs` with `APP_API_DOCS=true` |
| `src/whatsapp` | Webhook, router, transfer wizard, bill-pay wizard, PIN gate, ActionExecutor; `WhatsappTransportModule` (Cloud API) |
| `src/pin` | PIN challenge/verify |
| `src/cli` | Dry-run golden/fixture runner; ops CLIs (`settings:*`, `account:*`) |
| `src/common` | WAT, bank match, display name |

`AppModule` imports Prisma, config, schedule, Rubies, Allowance, Tagging, Onboarding, Manager, Whatsapp (last). AI + Orchestrator come in via WhatsappModule. Domain modules send via `MessagingModule`; the remaining circulars are Whatsapp↔Rubies and Allowance↔Email.

## 4. Routing

Both channels route through `ConversationRouterService` inside `TurnService.run`. Structured payloads → deterministic handlers. Pre-account text (and transcribed voice) → onboarding. Menu shortcuts → list. Weekly-review `AWAITING_LIMIT` intercepts only a parseable amount (or cancel words); other text abandons the wait and continues. Post-onboarding text, transcripts, and images → orchestrator.

Surfaces: `balance_read`, `limits_read`, `account_details`, `transfer_wizard`, `bill_payment_wizard`, `data_bundle_wizard`, `electricity_wizard`, `spending_menu`, `spend_summary`.

## 5. Data (Prisma)

User, DailyAllowance, Recipient (nickname, lastUsedAt), Transaction (purposeLabel, originChannel, originSurface, clientRequestKey), BillPaymentDraft, BillPayment (originChannel, originSurface, clientRequestKey), OverrideHistory, SettingsChangeRequest, onboarding/conversation sessions, TransferDraft, WeeklyReview, WhatsappMessage, AppMessage, UserTurnLease, AuthOtp, Device, AppSession, LoginChallenge, NameEnquiryLog, EmailVerification, PIN challenge, Rubies webhook log, LLM call log, nudges.

Identity is `User.phoneNumber`; `whatsappNumber` is nullable (set on first WhatsApp contact). A closed account (`closedAt`) has `phoneNumber` = `closed:<id>`, its number kept in `closedPhoneNumber` (ADR-0003). `TransferDraft` ≠ `ConversationSession`. Persona enum still `KEDU` | `MANAGER`. Session `contextData.spendCheck` holds pending send hints during the pre-wizard spend check.

## 6. Integrations

WhatsApp Cloud API (`WHATSAPP_DRY_RUN`), Rubies (`RUBIES_DRY_RUN`), Deepgram STT (`DEEPGRAM_API_KEY`), LLM (`AI_PROVIDER=stub|anthropic|openrouter|gemini|bedrock`).

## 7. Commands

`start:dev`, `start:prod` (migrate deploy then `node dist/main`), `test`, `lint`, `e2e` / `e2e:smoke`, `orchestrator:golden`, `orchestrator:cli`, `docs:check`, `security:check`. CI: security:check, docs:check, lint, prisma generate/migrate, build, unit test. Not in CI: e2e, live LLM.

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
- Production is **Railpack**: empty Build command (Railpack runs `npm run build` itself). Never custom-build with `npm ci` — that EBUSY-locks `node_modules/.cache`. Start is `node scripts/start-prod.js`. Local watch mode is `npm run start:dev`.

## 10. Active initiatives

- `initiatives/spend-check-before-send` — first chat send gets one coaching question before the wizard; purposeLabel on Transaction; remaining allowance is not a skip.
- `initiatives/whatsapp-media-and-spend-pushback` — Deepgram STT, inbound images, first-send pause including purpose/fee-path; text replies only.
- `initiatives/transfer-intent-grounding` — closed-send utterances must not relaunch the wizard; completed sends are written into chat history.
- `initiatives/beneficiary-prefill` — completed; nickname prefill for repeat sends (confirm/PIN unchanged).
- `initiatives/bill-payments` — completed; airtime, data bundles, prepaid electricity via `baas-vas/*` (confirm → PIN → execute).
- `initiatives/ai-money-intents` — chat prefill for bills/beneficiaries, typed Other purpose, linguistic amounts.
- `initiatives/weekly-review-limit-escape` — completed; Adjust-limits wait is amount-only; greetings and other intents (and 24h TTL) leave the prompt.
