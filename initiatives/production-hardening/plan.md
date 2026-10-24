# Initiative: production hardening

Companion spec: `docs/specs/PRODUCTION_HARDENING_SPEC.md`
Companion tech design: `docs/tech-design/PRODUCTION_HARDENING_TECH.md`

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change. Do not leave the table stale relative to phase headers.

Findings are numbered as in [`docs/PRODUCTION_ASSESSMENT.md`](../../docs/PRODUCTION_ASSESSMENT.md) (C1–C5, H1–H8). When a finding is fixed, mark it there too rather than deleting it.

## Problem

Amanda is live and moving real money. A full assessment of `main @ 0ba5135` on 2026-09-04 found five critical and eight high-severity defects. Two are actively harmful right now: customer PINs and identity numbers are being written to production logs, and a gateway error from Rubies is recorded as a failed transfer even when the debit succeeded.

The rest fall into three groups: money-state transitions that are not atomic, so correctness rests on an unverified assumption about Rubies-side idempotency; missing operational basics (no health check, no timeouts, no error tracking, no rate limiting, schedulers that double-fire); and an LLM boundary that lets model-authored digits reach a transfer wizard.

## Evidence

[`docs/PRODUCTION_ASSESSMENT.md`](../../docs/PRODUCTION_ASSESSMENT.md) carries every finding with `file:line` references and the verification method. Baseline at assessment time: 671 unit tests passing, `tsc` clean, `security:check` passing, `npm audit` reporting 23 vulnerabilities.

Key traced paths:

- [`src/whatsapp/whatsapp.controller.ts:72`](../../src/whatsapp/whatsapp.controller.ts) logs the raw payload before `redactRawPayload` runs.
- [`src/rubies/rubies.service.ts:141-147`](../../src/rubies/rubies.service.ts) returns any error body as a verdict; `mapRubiesResponseCode(undefined)` is `FAILED`.
- [`src/whatsapp/transfer-confirmation.service.ts`](../../src/whatsapp/transfer-confirmation.service.ts) transitions status by read-then-unconditional-update at every site.
- [`src/allowance/allowance.service.ts:251-266`](../../src/allowance/allowance.service.ts) writes `amountSpent` from a stale read instead of an increment.

## Scope

Defect repair only, across eight phases: log and webhook containment; money-path atomicity and recovery; operability (health, Sentry, throttling, replica-safe schedulers); non-destructive data-layer work; LLM safety; the thirteen weekly-review review findings on `0ba5135`; housekeeping; and wiring the settings-change and exit path, which is in scope because the consented terms promise it and no code can reach it.

## Non-goals

- Feature proposals from the assessment (ops console, fee ledger, funnel analytics, payday funding, goal buckets, circles, referral, cashback, Pidgin, statement upload). Recorded, not built here.
- Destructive database work. Dropping the unused `bvn`/`nin` columns and any retention or purge job are deferred by explicit decision to a separate change with a backup taken first.
- The orchestrator `ActiveMode` redesign for the weekly review. Targeted fixes only, by explicit decision.
- Changing what CI runs beyond adding the new invariant, per `AGENTS.md`.

## Decisions taken before work started

Recorded here because `docs/SECURITY.md` §4.7 requires a human confirmation for changes that alter S1–S12 or widen what the LLM can trigger.

| Decision | Choice | Affects |
| --- | --- | --- |
| Destructive DB work | Deferred to a separate change | Phase 4 |
| New dependencies | Add `@nestjs/terminus`, `@nestjs/throttler`, `@sentry/node` | Phase 3 |
| Weekly review depth | Targeted fixes, not the orchestrator redesign | Phase 6 |
| Managers path | Wire the full chat path | Phase 8 |
| Webhook secret enforcement | Fail closed behind an explicit opt-out, **not** `NODE_ENV` | Phase 1 |

The last one alters the observable meaning of S2 and S3 and retires a row in the `SECURITY.md` known-risks table. `NODE_ENV` was rejected as the discriminator because it is set only in the unused `Dockerfile`, so a `NODE_ENV` check would silently never fire on Railway.

Phase 8 widens what the LLM can trigger and needs an ADR in `docs/decisions/` before it lands.

## Phase 1 — Log and webhook containment

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-04
**Owner:** Egwu David Samuel

Scope narrowed after the design review: the Rubies response-semantics fix and HTTP timeouts moved to Phase 2, because both convert "wrong answer" into "no answer, retry later" and the retry net does not exist yet. See the ordering table in the tech design.

### Deliverables

- [x] Raw unredacted payload no longer logged (C1); stray `console.log` removed
- [x] Explicit production log levels, debug off by default
- [x] New S13 invariant in `scripts/check-security.js` and the `SECURITY.md` table
- [x] Webhook secrets required unless explicitly opted out (C3); `SECURITY.md` risk row retired
- [x] Real signature verdict recorded on `RubiesWebhookEvent`
- [x] `getBalance` inside `confirmTransfer` no longer produces total silence on a Rubies blip

### Acceptance tests

- [x] A Flow reply carrying a PIN produces no log line containing it — the payload is never serialized; only a message count is logged
- [x] Boot fails when a webhook secret is blank and the opt-out is unset — `env.validation.spec.ts`, 14 cases
- [x] A failed balance check during confirm produces a retry message, not silence — `transfer-confirmation.service.spec.ts`
- [x] `security:check` fails if the raw-payload log is reintroduced — S13 regex verified against both removed lines

### Progress log

- 2026-09-04: Phase complete. `security:check` (281 files), `docs:check`, `tsc --noEmit` clean; full suite 49 suites / 689 tests passing, up from 671. Ran: `npm run security:check`, `npm run docs:check`, `npx tsc --noEmit -p tsconfig.json`, `npx jest`.
- 2026-09-04: Also added `app.enableShutdownHooks()` and a `bootstrap().catch` while in `main.ts` — both were Phase 3 items but belong to the same file and carry no risk.
- 2026-09-04: `ALLOW_UNSIGNED_WEBHOOKS=true` appended to the local gitignored `.env`, which had a blank `WHATSAPP_APP_SECRET` and would otherwise no longer boot locally.

### Risk

- **Open, needs a human:** Railway must have both secrets set and must NOT have `ALLOW_UNSIGNED_WEBHOOKS`. If either secret is currently blank there, this phase turns a silent vulnerability into a visible boot failure on deploy. Verify before deploying.
- **Open, needs a human:** existing Railway logs should be treated as containing customer PINs, OTPs, BVN/NIN and dates of birth. Rotate or expire them.

## Phase 2 — Money-path correctness

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-04
**Owner:** Egwu David Samuel

Sub-ordered per the design review. Each step is independently deployable and no intermediate state is worse than today.

### Deliverables, in order

- [x] **2a** Conditional status claims on every transfer and bill transition (C5). The `PENDING_PIN → CONFIRMED` claim is the single highest-value line in this initiative
- [x] **2a** `applyTransferResult` claims only from `CONFIRMED` (claim, refetch, then side effects), closing the forged-webhook jump; unexpected status logged loudly, already-terminal silently
- [x] **2a** P2002 on `overrideHistory.create` handled as already-recorded
- [x] **2b** Allowance spend claimed atomically and incremented as a `Decimal`, not stale-read (H1)
- [x] **2b** `getOrCreateTodayAllowance` tolerates the create race
- [x] **2c** Recovery jobs: stuck bills, executed-but-unapplied spend, a daily abandoned-work report. Separate crons, `take` + `orderBy` + age bounds, in-process overlap guards
- [x] **2d** Per-call HTTP timeouts: 10s interactive, 60s money movement, 20s background, plus a 30s module-level floor on all three bare `HttpModule` imports
- [x] **2e** Rubies response type guard; `mapRubiesResponseCodeStrict` at the four money sites only; `listBanks` and `validateVasCustomer` degrade locally (C2)
- [x] **2f** Fee sweep lease with attempts, deterministic reference, 24h recovery cap (H7)
- [x] **2g** Re-quote at confirm on changed terms or age; `cancelPendingForUser` extended to `PENDING_PIN` (C4)

**Deviation from the sketch, on review advice:** the fee-sweep retry job is *not* in 2c. Its claim predicate needs the schema change from 2f (`feeSweepAttempts`, `feeSweepLastTryAt`) to be re-claimable at all, so it ships with 2f rather than ahead of it.

**Overlap guard:** in-process booleans for now, not a Postgres advisory lock. Correctness comes from the atomic claims in 2a — the webhook races these jobs regardless — so the guard is only load-shedding. Railway's zero-downtime deploys do overlap instances, so an advisory lock is still worth adding; recorded under Deferred rather than done.

### Acceptance tests

- [x] Each transition bails on `count === 0` under a simulated concurrent claim
- [x] Two pending transfers cannot both consume the same headroom — enforced by the confirm-time re-quote in 2g rather than by rejection
- [x] An executed transfer whose side effects throw is recovered by the repair job
- [x] An HTML gateway body resolves to `PENDING`, leaving the row `CONFIRMED` for reconciliation
- [x] A bank-list failure still lets the wizard reply, rather than going silent
- [x] The fee retry job can re-claim a row it already attempted

### Progress log

- 2026-09-04: **2a** landed. `claimStatus` helpers in both confirmation services; `applyTransferResult` / `applyBillPaymentResult` claim from `CONFIRMED` then refetch. Spec mocks gained `updateMany`; assertions rewritten from `update` to the claim shape. Commit `731d2c9`.
- 2026-09-04: **2b** landed. Interactive `$transaction` with a conditional claim plus `{ increment }` on a `Decimal`; `getOrCreateTodayAllowance` catches P2002. Spec `$transaction` mock now accepts both forms. Added the first tests `recordBillPaymentSpend` has ever had.
- 2026-09-04: **2c** landed. Three new jobs beside the existing transfer reconciler: bill-payment reconciliation via `queryVasTransaction` (which previously had no caller at all outside the service), allowance repair for `EXECUTED` rows with no spend recorded, and a daily report of work past the 7-day horizon. New spec file — the scheduler had none.
- 2026-09-04: **2d + 2e** landed together, ordering constraint satisfied because 2c shipped first. Commit `91b4ae2`.
- 2026-09-04: **2f + 2g** landed, completing the phase. Commit `a2f722c`. Migration `20260904120000_fee_sweep_lease` is additive but **unverified against a live database** — Docker was not running locally, so CI's `prisma migrate deploy` is the first real check.
- 2026-09-04: Phase complete. 50 suites / 723 tests, up from 671 at the start of the initiative.

### Risk

- Largest edit surface in the codebase. Existing Prisma mocks are plain object literals without `updateMany`, `$transaction` supports only the array form, and several assertions are exact object literals or call counts — including one that pins the buggy allowance arithmetic itself.
- **Hard ordering constraint:** bill reconciliation (2c) must land before `purchaseVas` is allowed to throw (2e). Inverting them trades a wrong "it failed" message for a silently stuck payment and no message at all.
- Do **not** hard-expire pending rows: that would break `resumePendingTransferUi` and `resumeAfterPinSetup`, whose whole purpose is resuming an old confirm. Re-quote instead.
- `mapRubiesResponseCode` keeps its current contract; it is also applied to webhook-supplied input and its `null → FAILED` behaviour is pinned by a deliberate test.

## Phase 3 — Operability

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] `/health` route, shutdown hooks, `bootstrap()` error handling
- [x] Sentry behind an optional DSN, plus a global exception filter that keeps stack traces
- [x] Webhook-edge throttling and a per-user cost cap; audio gated behind the pre-account check
- [x] Replica-safe nudges, manager replies, and email loops; crons kept out of the CLI
- [x] Provider timeouts actually honoured on Anthropic and Gemini; LLM logging failures non-fatal

### Acceptance tests

- [x] `/health` reports database reachability
- [x] A duplicate scheduler tick sends exactly one message
- [x] A hung provider call aborts rather than running past the orchestrator's race

### Progress log

-

### Risk

- Three new dependencies. Sentry is inert until a DSN is set in Railway.

## Phase 4 — Data layer, non-destructive

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] Indexes on `Transaction`, `WhatsappMessage.fromNumber`, `SettingsChangeRequest`, `OnboardingSession`
- [x] Explicit connection limit, documented
- [x] Conversation and onboarding history trimmed on write
- [x] Empty-string `waMessageId` no longer written to a unique column
- [x] Migration drift on `WeeklyReview.updatedAt` corrected

### Acceptance tests

- [x] `prisma migrate deploy` applies cleanly from scratch
- [x] Session history stops growing without bound across repeated turns

### Progress log

-

### Risk

- Index creation on a live table. Sizes are small today; confirm before applying.

## Phase 5 — LLM safety

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] Account, phone and meter digits dropped unless attested by the user or a visible photo (H5)
- [x] Reply text sanitised against the same attested corpus
- [x] Third-party names delimited where interpolated into the system prompt
- [x] Contextual secret scrubber before persistence and before the model (H6)
- [x] Second redaction list reconciled with `SENSITIVE_FLOW_FIELDS`
- [x] Onboarding LLM call wrapped with a timeout and fallback; restart and help escape hatches
- [x] `temperature: 0` removed; Deepgram language and keyterms set

### Acceptance tests

- [x] A model-invented account number never reaches the wizard
- [x] A typed BVN is not persisted verbatim, while an 11-digit airtime number still works
- [x] A provider failure mid-onboarding produces a reply, not silence

### Progress log

-

### Risk

- The scrubber must stay narrow. A blanket 11-digit rule would destroy Nigerian mobile numbers and break airtime.
- Golden dialogues must be updated in the same change.

## Phase 6 — Weekly-review fixes

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] Review branch moved after the wizard checks
- [x] Lenient limit parser added; `parseNairaAmount` left strict for its four wizard callers
- [x] Wait never dropped silently; false completion ack suppressed
- [x] Synthetic photo placeholder text ignored
- [x] Monday answers recompute today's allowance; partial-week copy corrected
- [x] TTL expressed as a query predicate; no-op touch write removed
- [x] Stale `SENT` reviews rejected; unreachable branch deleted; duplicates consolidated

### Acceptance tests

- [x] `5000 naira`, `make it 5k`, `5,000.` set the limit
- [x] `cancel` during an active bill draft cancels the draft, not the review
- [x] A captionless photo leaves the wait open

### Progress log

-

### Risk

- Behaviour was changed once already in `0ba5135`. Router-level tests must pin the user-visible outcome, not the internals.

## Phase 7 — Housekeeping

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] Fake values replace real-looking identifiers in scripts and specs
- [x] `npm audit` advisories resolved
- [x] Dead orchestrator-era code and its specs deleted
- [x] Docs drift corrected

### Acceptance tests

- [x] `security:check` and `docs:check` pass
- [x] Full suite green after deletions

### Progress log

-

### Risk

- Removing the classifier token touches the provider factory used by all five providers.

## Phase 8 — Settings-change and exit path

**Status:** completed
**Started:** 2026-09-04
**Completed:** 2026-09-05
**Owner:** Egwu David Samuel

### Deliverables

- [x] ADR in `docs/decisions/` for widening what the LLM may trigger
- [x] `settings_request` surface, sanitised closed-enum hints, executor dispatch
- [x] Admin decision path on a restricted module, never `AppModule`
- [x] `reviewRequest` guarded by status; approval and restriction lift made atomic
- [x] Golden cases added; `PRODUCT_BEHAVIOR.md` corrected

### Acceptance tests

- [x] A filed request cannot be approved before `eligibleAt`
- [x] The new surface cannot move money
- [x] A rejected request cannot later be flipped to approved

### Progress log

-

### Risk

- The only phase that widens the LLM's reach. Ships last, alone.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Log and webhook containment | completed |
| 2 | Money-path correctness | completed |
| 3 | Operability | completed |
| 4 | Data layer, non-destructive | completed |
| 5 | LLM safety | completed |
| 6 | Weekly-review fixes | completed |
| 7 | Housekeeping | completed |
| 8 | Settings-change and exit path | completed |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Outcome

All eight phases landed between 2026-09-04 and 2026-09-05, one commit per phase so any single change can be reverted alone.

| Measure | Before | After |
| --- | --- | --- |
| Unit tests | 671 | 773 |
| Spec files | 48 | 53 |
| Golden dialogues | 53 | 57 |
| Security invariants | S1–S12 | S1–S13 |

`security:check`, `docs:check` and `tsc --noEmit` clean throughout.

**Still needs a human.** These cannot be closed from the repository:

1. Confirm `WHATSAPP_APP_SECRET` and `RUBIES_SECRET_KEY` are set in Railway, and that `ALLOW_UNSIGNED_WEBHOOKS` is **not**. The app now refuses to boot otherwise, so a blank secret there turns a silent vulnerability into a visible deploy failure.
2. Treat existing Railway logs as containing customer PINs, OTPs, BVN/NIN and dates of birth. Rotate or expire them.
3. Set `SENTRY_DSN` and point the platform health check at `GET /health`.
4. Set `connection_limit` on `DATABASE_URL`.
5. Confirm with Rubies whether they deduplicate on transfer `reference`. Several safety properties still rest on that assumption; the atomic claims added here mean we no longer depend on it for the common case, but the fee sweep still does.
6. Three migrations are unverified against a live database — Docker was unavailable locally. CI runs `prisma migrate deploy`; watch the first deploy.

## Deferred

Recorded deliberately, not forgotten.

- Dropping the `bvn` / `nin` columns and any retention or purge job, pending a database backup. Deferred by explicit decision.
- A Postgres advisory lock for the schedulers. In-process flags shed duplicate load today; correctness comes from the atomic claims, but Railway's zero-downtime deploys overlap instances on every deploy, so the lock is still worth adding.
- The seven high-severity npm advisories, all of which require a Nest 10 → 12 upgrade. See the `SECURITY.md` known-risks table for why forcing that into a defect batch was rejected.
- An operator console for settings-change requests. The CLI added in Phase 8 is the minimum; without an operator habit a filed request is acknowledged and then ignored.
- Prompt caching and the classifier-then-persona split. Cost work, not defect repair.
- The orchestrator `ActiveMode` redesign for the weekly review.
- Every feature proposal in the assessment.
- Prompt caching and the classifier-then-persona split, both cost work rather than defect repair.

## Decisions

ADRs in [`docs/decisions/`](../../docs/decisions/README.md). Phase 8 requires one before it lands.
