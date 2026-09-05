# Production hardening — task breakdown

Work breakdown for the remediation campaign on branch `Udara-codeReview-improvement`
(13 commits, `ba81758` → `6bd0f47`), derived from the 2026-09-04 assessment in
[`PRODUCTION_ASSESSMENT.md`](PRODUCTION_ASSESSMENT.md).

This document is the flat, trackable view. The narrative record with evidence,
acceptance tests and risk notes per phase lives in
[`initiatives/production-hardening/plan.md`](../initiatives/production-hardening/plan.md);
where the two disagree, the plan is the source of truth for *why* and this document
for *what*.

**Scope note:** feature proposals from the assessment were excluded by decision.
The one feature-shaped item included (Task 8) was included because the terms users
already consent to promise it.

| | |
| --- | --- |
| Branch | `Udara-codeReview-improvement` |
| Commits | 13 |
| Tests | 671 → 773 |
| Spec files | 48 → 53 |
| Golden dialogues | 53 → 57 |
| Security invariants | S1–S12 → S1–S13 |
| Migrations added | 3 (additive only) |

---

## Task 0 — Process and documentation setup

**Status:** done · **Commits:** across the branch

Required before production code by `AGENTS.md`, and enforced by `npm run docs:check`.

- [x] 0.1 Write the assessment to `docs/PRODUCTION_ASSESSMENT.md` and register it in the `docs/README.md` ownership map
- [x] 0.2 Create `initiatives/production-hardening/plan.md` with one phase per task below
- [x] 0.3 Create `docs/specs/PRODUCTION_HARDENING_SPEC.md`, register it in `docs/specs/README.md`
- [x] 0.4 Create `docs/tech-design/PRODUCTION_HARDENING_TECH.md`, register it in `docs/tech-design/README.md`
- [x] 0.5 Register the initiative in `initiatives/README.md`
- [x] 0.6 Record the human confirmation required by `SECURITY.md` §4.7 before altering S1–S13

---

## Task 1 — Log and webhook containment

**Status:** done · **Commit:** `ba81758` · **Severity:** critical · **User-visible change:** none

Highest urgency: customer secrets were being written to the production log sink,
and blank webhook secrets silently accepted forged requests.

- [x] 1.1 Remove the raw unredacted webhook payload log in `whatsapp.controller.ts` — it ran *before* redaction, so every PIN, OTP, BVN, NIN and date of birth submitted through a Flow was logged. Replace with a message count
- [x] 1.2 Remove the stray `console.log("success")`
- [x] 1.3 Stop serialising Rubies webhook payloads (counterparty account numbers and names) into logs
- [x] 1.4 Add explicit log levels in `main.ts` behind `LOG_LEVEL`, defaulting to `error`/`warn`/`log` — Nest's default enables `debug`
- [x] 1.5 Add security invariant **S13** to `scripts/check-security.js` so the raw-payload log cannot be reintroduced; add the matching row to the `SECURITY.md` §2 table
- [x] 1.6 Require both webhook secrets at boot unless `ALLOW_UNSIGNED_WEBHOOKS=true` is set explicitly. Keyed off an explicit opt-out, **not** `NODE_ENV` — nothing in the Railway deployment sets `NODE_ENV`, so a `NODE_ENV` check would never fire where it matters
- [x] 1.7 Propagate the escape hatch to `.env.example`, `e2e/.env.e2e.example`, `docs/DEVELOPMENT.md`, `e2e/README.md`; retire the corresponding `SECURITY.md` §6 known-risk row
- [x] 1.8 Record the real signature verdict on `RubiesWebhookEvent` — it was hardcoded `true`, which was a lie whenever the blank-secret path fired
- [x] 1.9 Stop a Rubies blip during `getBalance` inside `confirmTransfer` producing total user silence

---

## Task 2 — Money-path correctness

**Status:** done · **Commits:** `731d2c9`, `91b4ae2`, `a2f722c` · **Severity:** critical
**Largest edit surface in the codebase.** Sub-ordered so each step is independently
deployable and no intermediate state is worse than the starting point.

### 2a — Atomic status claims

- [x] 2a.1 Replace every read-then-write transition in `transfer-confirmation.service.ts` with a conditional `updateMany({ where: { id, status: <expected> } })`, bailing on `count === 0`
- [x] 2a.2 Same for `bill-payment-confirmation.service.ts`
- [x] 2a.3 Make `applyTransferResult` claim only from `CONFIRMED`, then refetch, then run side effects — this also closes the forged-webhook path where a `SUCCESS` event jumped a `PENDING_PIN` row straight to `EXECUTED`
- [x] 2a.4 Distinguish benign already-terminal states (silent) from unexpected ones (logged loudly)
- [x] 2a.5 Handle P2002 on `overrideHistory.create` as already-recorded

### 2b — Allowance atomicity

- [x] 2b.1 Convert `recordSpend` and `recordBillPaymentSpend` to an interactive `$transaction` with a conditional claim plus `{ increment }` — two spends on the same day previously both read the same `amountSpent` and one silently vanished
- [x] 2b.2 Pass the `Decimal` straight through; never `Number()` it (precision loss on `Decimal(14,2)`)
- [x] 2b.3 Catch P2002 in `getOrCreateTodayAllowance` so a message racing the midnight cron does not throw out of `initiateTransfer`

### 2c — Recovery jobs

- [x] 2c.1 Reconcile bill payments stuck in `CONFIRMED` via `queryVasTransaction` — which had no caller at all outside its own service
- [x] 2c.2 Repair `EXECUTED` transactions with `appliedToAllowanceAt` null, whose spend was otherwise never recorded. Attributes to the day the transaction was created, not "now"
- [x] 2c.3 Add a daily report of work past the 7-day give-up horizon
- [x] 2c.4 Bound every job: `take`, `orderBy` ascending, age floor, in-process overlap guards
- [x] 2c.5 Log instead of silently `continue` on a null `idempotencyKey`

### 2d — HTTP timeouts

- [x] 2d.1 Per-call timeouts: 10s interactive, 60s money movement, 20s background
- [x] 2d.2 30s module-level floor on all three bare `HttpModule` imports, which previously waited forever

### 2e — Rubies response semantics

- [x] 2e.1 Add a type guard so an error body is returned only when it carries a string `responseCode` — a 502 HTML page was becoming a response with `responseCode: undefined`
- [x] 2e.2 Add `mapRubiesResponseCodeStrict` mapping a missing code to `PENDING`, applied at the **four money sites only**. "We do not know" must never be recorded as "it failed"
- [x] 2e.3 Let `listBanks` and `validateVasCustomer` degrade locally rather than throw — making them throw would have turned bank-list and meter lookups into total user silence

### 2f — Fee sweep

- [x] 2f.1 Lease the sweep with `feeSweepAttempts` + `feeSweepLastTryAt` before calling Rubies. A `feeSweepReference: null` predicate would have latched after attempt 1 and permanently disabled the retry job it exists for
- [x] 2f.2 Add `retryUnsweptFees()` with a 24h recovery cap
- [x] 2f.3 Migration `20260904120000_fee_sweep_lease`

### 2g — Stale transfer terms

- [x] 2g.1 Re-quote at confirm time when type or fee changed, or the row is old. **Not** a hard expiry — that would break `resumePendingTransferUi` and `resumeAfterPinSetup`, whose whole purpose is resuming an old confirm
- [x] 2g.2 Extend `cancelPendingForUser` to `PENDING_PIN`

> **Ordering constraint that must be preserved on any revert:** 2c must land before 2e.
> Inverting them trades a wrong "it failed" message for a silently stuck payment and no
> message at all.

---

## Task 3 — Operability

**Status:** done · **Commit:** `9656a9d` · **Adds 3 dependencies**

- [x] 3.1 `GET /health` (Terminus) pinging Postgres with `SELECT 1` — Railway previously had no way to tell a booted process from a working one
- [x] 3.2 `app.enableShutdownHooks()` so Prisma disconnects on SIGTERM instead of dropping connections mid-flight
- [x] 3.3 `bootstrap().catch()` — a bad env var previously looked like a silent crash loop
- [x] 3.4 Sentry behind an optional `SENTRY_DSN`, stripping request data, cookies and headers
- [x] 3.5 Global exception filter that preserves stack traces — every existing handler used `String(err)`, which discards them
- [x] 3.6 Throttler at the webhook edge (300/min)
- [x] 3.7 Per-user inbound cost cap (40 messages / 10 min), counted off `WhatsappMessage`'s existing index; explains once at the boundary then stays silent
- [x] 3.8 Move the audio branch behind the pre-account check so strangers cannot burn Deepgram spend
- [x] 3.9 Replica-safe nudges: `NudgeLog.dedupeKey` claimed *before* sending; migration `20260904130000_nudge_log_dedupe_key`
- [x] 3.10 Replica-safe manager replies: claim `initialReplySentAt` before the LLM call, release on failure
- [x] 3.11 Per-user try/catch in the email scheduler loops — one throw previously skipped everyone after it
- [x] 3.12 Gate `ScheduleModule.forRoot()` behind `DISABLE_SCHEDULERS`, set by the CLIs, so running a CLI no longer turns a laptop into a second production replica
- [x] 3.13 Honour `timeoutMs` on Anthropic and Gemini (previously Bedrock and OpenRouter only)
- [x] 3.14 Make LLM logging failures non-fatal — a logging failure previously turned a good turn into the fallback menu

---

## Task 4 — Data layer (non-destructive only)

**Status:** done · **Commit:** `d8954ec`

- [x] 4.1 Index `Transaction` on `[userId, status, createdAt]`, `[status, confirmedAt]`, `[status, appliedToAllowanceAt]` — it previously had nothing beyond its primary key and `idempotencyKey`, yet is scanned twice per chat turn
- [x] 4.2 Index `WhatsappMessage` on `[fromNumber, createdAt]`
- [x] 4.3 Index `SettingsChangeRequest` and `OnboardingSession`, which had none
- [x] 4.4 Trim `ConversationSession.messages` (50) and `OnboardingSession.messages` (60) on write — both were read-modify-written whole, twice per turn, and never trimmed
- [x] 4.5 Stop writing an empty-string `waMessageId` into a unique column, which made the second such send throw *after* delivery
- [x] 4.6 Correct the `WeeklyReview.updatedAt` drift between schema and migration `20260902220000`
- [x] 4.7 Document an explicit `connection_limit` on the database URL
- [x] 4.8 Migration `20260904140000_query_path_indexes`

---

## Task 5 — LLM safety

**Status:** done · **Commit:** `50179aa`

- [x] 5.1 Digit provenance: drop model-proposed account, msisdn and meter digits unless they appear in the user's recent turns or stored photo hints, with an explicit exception when an image is visible this turn (reading digits off a photo is a documented feature)
- [x] 5.2 Sanitise `reply_only` text against the same attested corpus, plus strip URLs — so the model cannot relay an account number the user never supplied
- [x] 5.3 Delimit third-party strings (bank-supplied account names, user nicknames) where interpolated into the system prompt
- [x] 5.4 Contextual free-text secret scrubber before persistence and before the model. **Deliberately narrow:** `bvn`/`nin` + 11 digits, `pin`/`otp` + 4–6 digits only. A blanket 11-digit rule would destroy Nigerian mobile numbers and break airtime
- [x] 5.5 Reconcile the second redaction list in `llm-call-logger.service.ts` with `SENSITIVE_FLOW_FIELDS`, which a comment falsely claimed it mirrored
- [x] 5.6 Wrap the onboarding LLM call with a timeout and canned fallback — a provider blip previously meant total silence mid-onboarding
- [x] 5.7 Add `help`/`restart` escape hatches to the pre-account dispatch, narrowed to explicit phrases so they cannot swallow legitimate answers
- [x] 5.8 Remove `temperature: 0` — current Claude models reject it with a 400, which would fall back to the menu on every turn
- [x] 5.9 Fix the `String(raw.msisdn ?? raw.phone)` bug where a numeric msisdn beat a string phone
- [x] 5.10 Deepgram: explicit language plus keyterm boosting (naira, telcos, banks) instead of `detect_language`

---

## Task 6 — Weekly-review fixes

**Status:** done · **Commit:** `7161bbd` · **Closes 13 review findings on `0ba5135`**

Targeted fixes by decision, not the orchestrator redesign.

- [x] 6.1 Move the `AWAITING_LIMIT` branch *after* the menu, bill-draft and transfer-draft checks, so a wizard amount or a wizard `cancel` is never stolen by the review
- [x] 6.2 Add a lenient limit parser for amounts; keep `parseNairaAmount` strict for its four wizard callers, which depend on its anti-guess contract. Verified failures fixed: `5000 naira`, `make it 5k`, `5000 a day`, `7000/day`, `5,000.`, `Five thousand.`
- [x] 6.3 Never drop the wait silently — always acknowledge, then continue the utterance
- [x] 6.4 Suppress the "glad that went through" ack in that same turn, so "thanks" cannot produce a false completion message
- [x] 6.5 Ignore synthetic placeholder text — a captionless photo entered as the literal `(user sent a photo)` and closed the review
- [x] 6.6 Recompute today's allowance when a Monday answer overrides the current week; fix the "×7" copy for a partial week
- [x] 6.7 Express the TTL as a query predicate rather than a write inside a getter, removing the read-then-write race
- [x] 6.8 Delete `touchAwaitingLimit`, which wrote a status the row already had purely to bump `@updatedAt`
- [x] 6.9 Reject stale `SENT` reviews from previous weeks in `handleChoice`
- [x] 6.10 Delete the unreachable `amount == null` branch and the spec asserting it
- [x] 6.11 Hoist one `CANCEL_WORDS` into `src/common/`, replacing the byte-identical private copy
- [x] 6.12 Consolidate the three copies of the "complete with no override" update into one shared claim

---

## Task 7 — Housekeeping

**Status:** done (one item partial) · **Commit:** `704f45e`

- [x] 7.1 Replace real-looking phone and wallet numbers in `scripts/rubies-vas-*.mjs` and `rubies.service.spec.ts` with obviously fake values, per `SECURITY.md` §4.3
- [x] 7.2 Delete dead pre-orchestrator code: `KeduChatService`, `IntentRouterService`, `menu-intent.prompts.ts`, `validateMenuIntent`, `MenuIntent`, and the `CLASSIFIER_LLM` provider registration
- [x] 7.3 Correct docs drift: the `SECURITY.md` claim that golden dialogues are not in CI, and the `docs/README.md` Flow asset list
- [~] 7.4 **Partial — `npm audit`.** Advisories fixable without a breaking change were resolved. **44 remain (4 low, 33 moderate, 7 high).** All remaining fixes require `npm audit fix --force`, which installs `@nestjs/cli@12` — a Nest 10 → 12 migration. Deliberately not forced; tracked as deferred work below

---

## Task 8 — Settings-change and exit path

**Status:** done · **Commit:** `be5c6bd` · **The only task that widens what the LLM can trigger**

The terms every user consents to promise they can ask to change limits or leave, that
the request goes to "the managers", and that a waiting period applies. None of it was
reachable: `fileChangeRequest` and `reviewRequest` had no caller outside their own
module, and `PRODUCT_BEHAVIOR.md` described the mechanism as "Verified".

- [x] 8.1 Write ADR-0001 in `docs/decisions/`, required by `SECURITY.md` §4.7 before widening LLM reach
- [x] 8.2 Add a `settings_request` surface to the orchestrator registry with an eligibility predicate
- [x] 8.3 Sanitise the new hints as a closed enum (`WINDOW_HOURS | OVERRIDE_FEES | EXIT_RESTRICTIONS | OTHER`) plus a bounded reason (≤300 chars)
- [x] 8.4 Dispatch from the action executor into `fileChangeRequest`, defaulting to `OTHER`
- [x] 8.5 Confirm the validator still refuses to let this surface move money, and that it cannot influence `eligibleAt` or set `disciplineExitedAt`
- [x] 8.6 Add the operator decision path as a CLI (`settings:list` / `settings:decide`) on a restricted boot with `DISABLE_SCHEDULERS=true` — not an HTTP route, because the app has no admin identity model and the first thing such a route would do is lift spending restrictions
- [x] 8.7 Guard `reviewRequest` by status, so a rejected request cannot later be flipped to approved
- [x] 8.8 Make the approval and the restriction lift a single transaction — a failure between them previously left a request approved with restrictions never lifted
- [x] 8.9 Add 4 golden dialogue cases (53 → 57) and correct `PRODUCT_BEHAVIOR.md`

---

## Task 9 — Pre-merge verification

**Status:** done · **Commit:** `6bd0f47`

Found by running every CI gate locally, including ones the earlier phases had not exercised.

- [x] 9.1 **Fix the CI-blocking lint failure.** `npm run lint` is a CI gate and was failing on 4 unused symbols: `MENU_INTENT_VALUES`, `parseNairaAmount`, `BILL_CANCEL_WORDS` (all leftovers from Tasks 6 and 7) and `startOfWatMonthInstant` (**pre-existing on `main`** — that file is untouched by this branch and the lint config is identical, so `main` is red too)
- [x] 9.2 Apply the Prettier reformatting `eslint --fix` produces across 24 files. Verified as cosmetic by running Prettier over the committed version of each file and confirming byte-identical output — 24 of 24, zero unexplained
- [x] 9.3 **Stop the health endpoint leaking infrastructure detail.** It returned `String(err)` in the response body; Prisma connection errors name the database host and port, and the route is unauthenticated — while the comment above it promised "free of detail". The reason now goes to the log stream
- [x] 9.4 **Fix a latent migration drift bug.** The `SettingsChangeRequest` index name was 64 characters; Postgres truncates at 63, giving `...initialReply_id`, while Prisma expects `...initialRepl_idx`. The index would work, but every future `prisma migrate dev` would see permanent drift and try to drop and recreate it. Had to be fixed *before* the migration is applied. All 7 index names across the full migration history now match Prisma's expectations exactly
- [x] 9.5 Verify dependencies resolve cleanly for `npm ci` on Railway — declared, locked, installed, no peer conflicts

### Gate results at `6bd0f47`

`security:check` · `docs:check` · `lint` · `tsc --noEmit` · `prisma validate` · `build`
· **773 tests / 53 suites** · **57 golden dialogues** — all green.

---

## Operational tasks — these need a human, and cannot be closed from the repo

Ordered by urgency. The first two are pre-deploy blockers.

- [ ] **OPS-1 — Confirm `WHATSAPP_APP_SECRET` and `RUBIES_SECRET_KEY` are set in Railway, and that `ALLOW_UNSIGNED_WEBHOOKS` is _not_.** Task 1.6 means the app now refuses to boot otherwise. If either secret is currently blank in Railway, this turns a silent vulnerability into a visible deploy failure. **Check before deploying.**
- [ ] **OPS-2 — Treat all existing Railway logs as containing customer PINs, OTPs, BVN/NIN and dates of birth.** Rotate or expire them. Task 1.1 stops the leak going forward; it does nothing about what is already there
- [ ] **OPS-3 — Set `SENTRY_DSN` and point the platform health check at `GET /health`.** Both features are inert until this is done
- [ ] **OPS-4 — Set an explicit `connection_limit` on `DATABASE_URL`**
- [ ] **OPS-5 — Confirm with Rubies whether they deduplicate on transfer `reference`.** Several safety properties rest on this assumption and no test verifies it
- [ ] **OPS-6 — Watch the first deploy.** The three migrations were never applied to a live database locally (Docker unavailable). Opening the PR runs CI's `prisma migrate deploy` against a real Postgres 16, which is the first genuine check — **do this before merging**
- [ ] **OPS-7 — Check row counts on `WhatsappMessage` and `Transaction` before applying Task 4's indexes.** `CREATE INDEX` takes a brief exclusive lock. Fine at current size; if either table is in the millions, create them manually with `CONCURRENTLY` first

---

## Deferred — recorded decisions, not oversights

- [ ] **DEF-1 — Drop the unused `bvn` / `nin` columns, and add a retention purge job.** Deferred by decision to a separate change with a backup taken first, because both are destructive
- [ ] **DEF-2 — Nest 10 → 12 upgrade**, which is what the 7 remaining high advisories (Task 7.4) actually require. The riskiest change in the set; not worth bundling with money-path work
- [ ] **DEF-3 — Postgres advisory lock for schedulers.** Today's in-process guards are load-shedding only; correctness comes from the atomic claims in Task 2a. Railway's zero-downtime deploys do overlap instances, so this is still worth adding
- [ ] **DEF-4 — Operator console**, so settings-change decisions are not gated on someone remembering to run a CLI. Without an operator habit, a filed request becomes a promise that is acknowledged and then ignored
- [ ] **DEF-5 — Prompt caching**
- [ ] **DEF-6 — Feature proposals from the assessment**, excluded from this campaign by decision

---

## Open observations from the final check — your call, not fixed

- [ ] **OBS-1 — The throttler is effectively global, not per-IP.** `trust proxy` is not set, so `req.ip` is Railway's proxy and all traffic shares one 300/min bucket — including the Rubies webhook, where a 429 means a credit notification is lost (the money still lands; the user is not told). Fine at current volume; it becomes real above roughly 5 webhook POSTs per second. Exempting the Rubies route would fix it but removes flood protection from a money endpoint
- [ ] **OBS-2 — `/health` has no spec.** The route is trivial and covered by nothing; low risk, but it is the one new route in the app
- [ ] **OBS-3 — `main` currently fails `npm run lint`** because of `startOfWatMonthInstant` (see Task 9.1). This branch fixes it, but any other branch cut from `main` inherits a red CI gate
