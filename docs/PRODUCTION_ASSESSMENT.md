# Production assessment

**Date:** 2026-09-04 · **Commit assessed:** `main @ 0ba5135` · **Audience:** founders and engineering

A full read of the code, the docs, the founding PDFs, and a verified code review of the most recent commit. Findings were traced through the named files, not inferred. Remediation is tracked in [`initiatives/production-hardening/plan.md`](../initiatives/production-hardening/plan.md).

This file is a point-in-time snapshot. It is **not** authority over behavior — [`PRODUCT_BEHAVIOR.md`](PRODUCT_BEHAVIOR.md) and [`SECURITY.md`](SECURITY.md) remain the sources of truth. As findings are fixed, mark them here rather than deleting them, so the record of what was wrong survives.

---

## Baseline at time of assessment

| Measure | Value |
| --- | --- |
| Source lines (`src/`, excluding specs) | 17,246 |
| Test lines / spec files | 10,745 / 48 |
| Unit tests | 671 passing, 0 failing |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run security:check` | passing (276 files) |
| `npm audit --omit=dev` | 23 vulnerabilities (7 high, 12 moderate, 4 low) |
| Findings | 5 critical, 8 high, plus medium and housekeeping |

---

## What Udara is

A WhatsApp-only spending-discipline agent on a real Rubies Microfinance wallet. Users fund it, and Udara becomes the only outbound path: a daily allowance derived from 30% of stated income, an 11:00–20:00 WAT spending window, confirm-then-PIN on every send, and airtime, data and electricity on the same rails. Free text reaches an LLM that can only *propose*; `ActionValidatorService` decides what happens.

Revenue in code is override fees only: ₦1,000 + 0.2% outside the window, ₦1,000 + 0.4% for borrowing against future days.

## What is genuinely good

Better engineered than most seed-stage fintech bots. The things that matter for a money product were done deliberately:

- **Security is written down and machine-checked.** Twelve invariants in [`SECURITY.md`](SECURITY.md), enforced by [`scripts/check-security.js`](../scripts/check-security.js) in CI, with a per-change checklist.
- **The LLM cannot move money.** Model output is a proposal; amount, account and bank are re-read from the database at execution time, never carried from model output. Verified end to end.
- **PIN handling is solid.** scrypt with per-user salt and inline params, escalating lockout (15 min → 60 min → 24 h), single-use challenges bound to one transaction, 5-minute expiry, and a reset that needs both the inbox and the WhatsApp number.
- **Webhooks are HMAC-checked over raw bytes**, constant-time, with a 5-minute replay window on the Rubies side. Meta redeliveries deduplicate on `waMessageId`.
- **Sensitive Flow fields are redacted at the persistence boundary**, BVN/NIN are deliberately never written to the user row ([`onboarding.service.ts:856-861`](../src/onboarding/onboarding.service.ts#L856-L861)), and balance is always read live from Rubies.
- **Email and weekly review claim a unique row before sending**, so they survive retries and a second replica. That is the pattern the other schedulers should copy.

---

## Critical

### C1 — Every PIN, OTP, BVN, NIN and DOB is printed to production logs

[`whatsapp.controller.ts:72`](../src/whatsapp/whatsapp.controller.ts#L72) debug-logs the raw webhook body *before* redaction runs. Flow replies carry the decrypted `response_json` with those fields in plaintext, and [`main.ts:10`](../src/main.ts#L10) never restricts log levels, so Nest's default prints `debug` in production. The redaction module built after an earlier BVN leak is bypassed one line earlier. Directly contradicts the checklist item at [`SECURITY.md`](SECURITY.md) §3.

**Fix:** drop the line or wrap in `redactRawPayload`; set production log levels; treat existing logs as leaked.

### C2 — A gateway error from Rubies becomes a permanent "failed" transfer

[`rubies.service.ts:141-147`](../src/rubies/rubies.service.ts#L141-L147) returns `axiosErr.response.data` for any HTTP error carrying a body. A 502 HTML page yields `responseCode: undefined`, which [`mapRubiesResponseCode`](../src/rubies/rubies.service.ts#L72-L78) maps to `FAILED`. The transaction goes terminal, the user is told "nothing was deducted" ([`transfer-confirmation.service.ts:588-592`](../src/whatsapp/transfer-confirmation.service.ts#L588-L592)), allowance is never debited, and the reconciler only queries `CONFIRMED` rows so it never revisits. Same defect in the status query and in VAS purchases. A 5xx at the edge is exactly when the debit may already have happened.

**Fix:** accept a body as a verdict only when it is an object with a string `responseCode`; otherwise throw so the row stays `CONFIRMED` for reconciliation. Treat a missing code as `PENDING`.

### C3 — Blank webhook secrets silently accept forged requests

Both guards return `true` with only a warning when the secret is unset ([`whatsapp-signature.guard.ts:34-42`](../src/whatsapp/whatsapp-signature.guard.ts#L34-L42), [`rubies-signature.guard.ts:41-46`](../src/rubies/rubies-signature.guard.ts#L41-L46)), both secrets are `@IsOptional()` in [`env.validation.ts`](../src/config/env.validation.ts), and no code anywhere reads `NODE_ENV`. A deploy missing one variable accepts forged messages as any phone number, or fabricated credits.

Compounding it: [`rubies-webhook.controller.ts:74`](../src/rubies/rubies-webhook.controller.ts#L74) hardcodes `signatureValid: true`, so unverified events are durably recorded as verified.

**Fix:** fail closed. Require both secrets unless an explicit opt-out flag is set. Note `NODE_ENV` is set only in the unused Dockerfile, so gating on it would silently never fire on Railway.

### C4 — The allowance and spending window can be bypassed without the LLM

Allowance and window are evaluated once at proposal time and frozen on the row ([`transfer-confirmation.service.ts:132-135, 184-186`](../src/whatsapp/transfer-confirmation.service.ts#L132-L135)). Nothing re-checks at confirm or PIN, pending transactions never expire, and only the orchestrator's cancel path clears them — the menu wizard cancels drafts, not pending transactions. With ₦10,000 left, three ₦8,000 sends can each classify `NORMAL` and all execute fee-free. A transfer proposed at 19:59 and PIN-confirmed at 23:00 escapes the early-access fee.

**Fix:** re-evaluate at confirm, expire pending rows, cancel other pending on create.

### C5 — Every money-state transition is read-then-write

Confirm, PIN-verified, and result-applied all read the status, check it in code, then issue an unconditional `update`. No transaction, no row lock, no conditional update. Two Confirm taps are two concurrent webhooks, so two PIN challenges get minted for one transaction and both can reach `initiateTransfer` with the same reference. Double debit is prevented only by Rubies deduplicating on reference, which nothing in this repo verifies. The webhook and the reconciler can likewise both run the success branch, duplicating the fee sweep.

**Fix:** claim each transition with `updateMany({ where: { id, status: <expected> } })` and bail on `count === 0`. [`pin.service.ts:417-426`](../src/pin/pin.service.ts#L417-L426) already does this.

---

## High

| # | Finding | Evidence |
| --- | --- | --- |
| H1 | An executed transfer can permanently skip the allowance: status is written `EXECUTED` before override history, fee sweep and `recordSpend` run as separate writes; any throw between leaves a terminal row with `appliedToAllowanceAt` null and nothing revisits it. `amountSpent` is also a stale-read write, not an increment. | [`transfer-confirmation.service.ts:522-547`](../src/whatsapp/transfer-confirmation.service.ts#L522-L547), [`allowance.service.ts:251-266`](../src/allowance/allowance.service.ts#L251-L266) |
| H2 | Most schedulers double-fire under two replicas: nudges check-then-send with no unique constraint, the manager reply calls the LLM and sends before stamping `initialReplySentAt`, and the reconciler has no overlap guard. `resend-monthly-summary-cli.ts` boots the full `AppModule`, so running it on a laptop starts every cron against production. | [`allowance.scheduler.ts:74-81`](../src/allowance/allowance.scheduler.ts#L74-L81), [`manager-conversation.service.ts:93-112`](../src/manager/manager-conversation.service.ts#L93-L112), [`resend-monthly-summary-cli.ts:56`](../src/cli/resend-monthly-summary-cli.ts#L56) |
| H3 | No health check, no shutdown hooks, no HTTP timeouts, no retries, no error tracking, no rate limiting. `HttpModule` is imported bare in three modules so every Rubies call is unbounded. Any phone number gets a user row and unlimited LLM turns; voice notes hit Deepgram before the pre-account check. | [`main.ts`](../src/main.ts), [`rubies.module.ts:19`](../src/rubies/rubies.module.ts#L19), [`whatsapp-router.service.ts:100-142`](../src/whatsapp/whatsapp-router.service.ts#L100-L142) |
| H4 | `Transaction` has no index beyond `idempotencyKey`, yet two scans run per chat turn and one per minute from the reconciler. `ConversationSession.messages` is read and rewritten whole twice per turn, never trimmed, with no serialization. Nothing in the codebase ever deletes a row. | [`schema.prisma`](../prisma/schema.prisma), [`orchestrator.service.ts:442-480, 819-833`](../src/orchestrator/orchestrator.service.ts#L442-L480) |
| H5 | The model can prefill any 10-digit account: hints accept any correctly-shaped digit run with no check it came from the user, and there is no filter on reply text for account numbers or URLs. A forwarded scam screenshot can seed the wizard; confirm and PIN are the only backstop. | [`transfer-hints.util.ts:52-64`](../src/orchestrator/transfer-hints.util.ts#L52-L64), [`action-executor.service.ts:46-59`](../src/orchestrator/action-executor.service.ts#L46-L59) |
| H6 | Typed PINs and BVNs are stored verbatim and sent to the model — redaction keys only off Flow field names. Onboarding's LLM call has no try/catch, no timeout and no fallback, so a provider blip is total silence mid-onboarding. | [`whatsapp-message.service.ts:72-77`](../src/whatsapp/whatsapp-message.service.ts#L72-L77), [`onboarding.service.ts:502-507`](../src/onboarding/onboarding.service.ts#L502-L507) |
| H7 | Bill payments and fee sweeps are never reconciled. A VAS purchase returning `PENDING` stays `CONFIRMED` forever unless the webhook arrives; `queryVasTransaction` has no caller outside the service. A failed fee sweep is never retried, and since it runs after the main debit the likely failure is insufficient balance — the fee is simply lost. | [`bill-payment-confirmation.service.ts:257-286`](../src/whatsapp/bill-payment-confirmation.service.ts#L257-L286), [`transfer-confirmation.service.ts:658-722`](../src/whatsapp/transfer-confirmation.service.ts#L658-L722) |
| H8 | The terms promise a 7-day exit path that does not exist. `fileChangeRequest` and `reviewRequest` have no caller outside the manager module; the only way to lift restrictions is a manual database edit. `PRODUCT_BEHAVIOR.md` marks Managers "Verified", which overstates what ships. | [`manager-conversation.service.ts:57, 190`](../src/manager/manager-conversation.service.ts#L57), [`terms.data.ts`](../src/onboarding/terms.data.ts) |

---

## Medium and housekeeping

- **Real identifiers committed.** A real-looking phone number and a Rubies wallet number are hardcoded in `scripts/rubies-vas-*.mjs`, and the same phone appears in [`rubies.service.spec.ts`](../src/rubies/rubies.service.spec.ts). [`SECURITY.md`](SECURITY.md) §4.3 forbids exactly this.
- **`npm audit`: 23 vulnerabilities, 7 high** (lodash, multer, tmp, glob, picomatch; moderate in @nestjs/core, body-parser, qs).
- **Outbound send with no Meta id** writes `waMessageId = ""` into a unique column, so the second such send throws after delivery ([`whatsapp.service.ts:78`](../src/whatsapp/whatsapp.service.ts#L78)).
- **Unrecognised Rubies payloads are logged wholesale** with counterparty account numbers and names ([`rubies-webhook.controller.ts:85-87`](../src/rubies/rubies-webhook.controller.ts#L85-L87)).
- **First allowance row of the day** is find-then-create with no P2002 catch, so a user message racing the midnight cron throws out of `initiateTransfer`.
- **If switching to Anthropic:** the orchestrator passes `temperature: 0` ([`orchestrator.service.ts:146`](../src/orchestrator/orchestrator.service.ts#L146)), which current Claude 5 models reject with a 400, so every free-text turn would fall back to the menu. Local env uses Gemini today.
- **No prompt caching.** Roughly 2k static tokens per turn are re-sent uncached, and the system prompt is flattened to one string so no cache breakpoint can be placed.
- **`timeoutMs` is a no-op on Anthropic and Gemini** — only Bedrock and OpenRouter honour it. The orchestrator races an 8.5s timer but the underlying request keeps running and costing.
- **Dead code still registered:** `KeduChatService`, `IntentRouterService`, `menu-intent.prompts.ts`, the `CLASSIFIER_LLM` token, `ConversationPersona.MANAGER`.
- **Docs drift:** [`SECURITY.md`](SECURITY.md) §6 says golden dialogues are not in CI, but they run under jest. The `bvn`/`nin` columns still exist despite the terms saying they are never stored. [`README.md`](README.md) omits `pin-reset.json` from the Flow asset list.
- **Git hygiene:** commit messages like "x" and "done" on a money product; deploys land around midnight UTC, exactly when the daily-boundary cron fires.

---

## Code review of `0ba5135` ("persistent state fixed")

The commit added a 24-hour timeout to the Sunday review's "Adjust limits" wait and routes non-amount text back to normal chat. Thirteen findings were filed; the five that reach users:

1. **Most natural answers silently kill the Adjust flow.** Verified against the compiled parser: `5000 naira`, `5000 a day`, `make it 5k`, `7000/day`, `5,000.` and `Five thousand.` all return null, so the review is closed with no message and the limit is never set. The old retry prompt is now dead code.
2. **The branch runs before the wizard checks**, so `500` meant for an airtime purchase is rejected as "too low" and `cancel` closes the review instead of the wizard, leaving the wizard live.
3. **A captionless photo or voice note** also closes the review silently; a photo captioned `5000` sets a weekly limit and the image never reaches the model.
4. **Answering on Monday** writes the override, but Monday's allowance row already exists with the old figure and is never recomputed, while the user is told "done. ₦7,000 a day, ₦49,000 for the week".
5. **`thanks` after a silent abandon** gets "glad that went through." even though the Adjust was just dropped.

The remaining eight are reuse, simplification and test-quality findings: an unreachable branch, a read-side write in a getter, a no-op status write repeated three times, three copies of the same completion update, a bill-payment constant imported into the weekly-review path, and tests that assert internals rather than behaviour.

---

## The business question

The only revenue line in code is the override fee, collected when a user breaks their own plan — and the founding PRD defines success as users *not* paying it. Fee sweeps also fail silently with no retry and no ledger, so nobody can state monthly revenue.

Three non-punitive lines fit the existing code: a small monthly subscription billed from the wallet inside the window, margin on the airtime, data and electricity purchases already being processed, and a percentage on group-savings payouts if circles are ever built. Keep the override fee as friction, and stop calling it the model.

Feature proposals are deliberately out of scope for the remediation initiative and are recorded separately.

---

## How this was verified

Unit tests, TypeScript compile, lint, `security:check` and `npm audit` were run on the checkout. Every critical and high finding was traced through the named files and lines. The parser behaviour in the code review was executed against the compiled build. Findings described as races were confirmed as code shape, not reproduced under load.

**Not verified, and needing a human:**

- Whether `WHATSAPP_APP_SECRET` and `RUBIES_SECRET_KEY` are actually set in the Railway environment. The local `.env` has the WhatsApp secret blank.
- Whether Rubies deduplicates on transfer `reference`. Several safety properties currently rest on that assumption.
