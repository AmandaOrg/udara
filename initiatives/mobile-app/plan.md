# Initiative: mobile app backend

Companion spec: [`docs/specs/MOBILE_APP_SPEC.md`](../../docs/specs/MOBILE_APP_SPEC.md)
Companion tech design: [`docs/tech-design/MOBILE_APP_TECH.md`](../../docs/tech-design/MOBILE_APP_TECH.md)
Decision record: [`docs/decisions/0002-app-channel-and-auth.md`](../../docs/decisions/0002-app-channel-and-auth.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change. Do not leave the table stale relative to phase headers.

Each phase ships on its own with CI green. Phases after P0 are outlined, not designed: each gets its detailed deliverables and acceptance tests here, and its section in the tech design, before its code starts.

## Problem

Udara only exists inside WhatsApp. A standalone iOS/Android app (TypeScript, Expo, in the sibling `udara-mobile` repo) has nothing to talk to:

- The only routes are the two signed webhooks and `/health`. There is no client API, no authentication, and no DTOs.
- Identity is `User.whatsappNumber`. A user is only ever created by `WhatsappRouterService.findOrCreateUser`.
- About 185 outbound sends across 12 classes call `WhatsappService` directly, so every workflow both decides and sends.
- KYC and PIN entry exist only as WhatsApp Flows.

## Evidence

Traced on `main @ 030b6a9`, 2026-09-25:

- [`src/whatsapp/whatsapp-router.service.ts`](../../src/whatsapp/whatsapp-router.service.ts): user creation, routing precedence, and the post-PIN step all live here.
- [`src/whatsapp/transfer-confirmation.service.ts`](../../src/whatsapp/transfer-confirmation.service.ts) and [`bill-payment-confirmation.service.ts`](../../src/whatsapp/bill-payment-confirmation.service.ts): `confirm*`/`cancel*` looked records up by id alone, trusting that only WhatsApp could supply the id.
- [`src/whatsapp/inbound-rate-limit.service.ts`](../../src/whatsapp/inbound-rate-limit.service.ts): counts inbound rows by `userId`, but `recordInboundIfNew` never set `userId`, so the cap counted zero.
- [`src/onboarding/onboarding.service.ts`](../../src/onboarding/onboarding.service.ts): the KYC form token was generated and never checked.

## Scope

Everything the backend needs so the app can stand alone:

- sign up and log in by SMS one-time code;
- onboard conversationally in an in-app chat, with KYC and PIN as native forms;
- chat with Udara;
- use native screens for balance, limits, history, recipients, transfers, bills, devices and settings requests;
- receive push notifications.

Users decided (2026-09-25, Egwu David Samuel):

1. **One account across channels.** WhatsApp keeps working, and the same phone number is the same `User` on both.
2. **Conversational onboarding in the app.** It uses the same stage machine as WhatsApp.
3. **SMS one-time codes** through a Nigerian provider (Termii or similar).
4. **Chat with Udara is in v1.**

## Non-goals

- The Expo app itself, which lives in `udara-mobile`.
- Voice notes and images sent from the app. Multipart uploads bring in multer, which [`SECURITY.md`](../../docs/SECURITY.md) currently lists as unreachable. Deferred.
- Changing the persona, prompts or golden dialogues. The "WhatsApp bubble" wording stays for v1.
- Retiring WhatsApp or migrating its users.
- The Nest 10 → 12 upgrade.

## Phase 0 — Paperwork and fixes that do not change WhatsApp behavior

**Status:** completed
**Started:** 2026-09-25
**Completed:** 2026-09-25
**Owner:** Egwu David Samuel

### Deliverables

- [x] This plan, the spec, the tech design, and ADR-0002, all registered in their indexes
- [x] The per-user inbound rate limit actually counts: `route()` links the row to the user (`WhatsappMessageService.attachUser`) before `InboundRateLimitService.check`
- [x] `confirmTransfer`, `cancelTransfer`, `confirmBillPayment` and `cancelBillPayment` take `userId` and only find the caller's own row
- [x] Bills match transfers:
  - `cancelBillPayment` is an atomic claim;
  - `cancelPendingForUser` also cancels `PENDING_PIN`;
  - confirm re-quotes after 10 minutes or when terms moved.
- [x] The KYC form token is recorded on `OnboardingSession.kycFlowToken` when the form is sent and claimed once when it comes back
- [x] `PinOutcomeService.apply` is the single place a verified PIN turns into execution. It is added to the S12 must-have-tests list.

### Acceptance tests

- [x] The router attaches the user before the rate check: `whatsapp-router.service.spec.ts`, "links the inbound row to the user before counting"
- [x] Another user's transaction or bill id is treated as not found on confirm and cancel: `transfer-confirmation.service.spec.ts`, `bill-payment-confirmation.service.spec.ts`
- [x] Button handlers pass the sender's own user id: `whatsapp-router.service.spec.ts`, "confirm and cancel buttons"
- [x] A stale bill quote re-quotes instead of asking for the PIN, and changed terms are stored and shown: `bill-payment-confirmation.service.spec.ts`
- [x] A stale, missing or duplicate KYC form token never reaches Rubies, and only one of two simultaneous submissions does: `onboarding.service.spec.ts`
- [x] Each PIN outcome triggers only its own action: `pin-outcome.service.spec.ts`
- [x] Full `npm test` (54 suites, 794 tests), `security:check`, `docs:check`, `tsc --noEmit` and lint on touched files green (2026-09-25)
- [x] `npm run e2e` against a local server, with no scenario changed: 14 passed, 3 skipped (live LLM and HMAC by design), 2 failed. Both failures are identical on untouched `main @ 030b6a9` (verified by stashing and re-running), so they are existing stale scenarios, not regressions. See Deferred.

### Progress log

- 2026-09-25: Plan approved. Fixes and tests written.
- 2026-09-25: Verification found that `.env` points `DATABASE_URL` at a hosted Railway database, and the e2e runner falls back to `.env`'s `DATABASE_URL`. Local server and e2e runs were done with explicit overrides to the docker Postgres (`postgresql://kedu:kedu@localhost:5433/kedu`), plus `SENTRY_DSN=` and `RESEND_API_KEY=`, so nothing touched hosted services.
- 2026-09-25: Decided to leave the widening of `PinFlowOutcome` (retry token, locked, expired) for P4. Once the messenger port exists, the retry form reaches the app as an ordinary form request, so the widening may not be needed. Revisit it when P4 is designed.

### Risk

- **Bill re-quote is new user-visible behavior on WhatsApp.** A purchase left for more than 10 minutes now comes back with a fresh card instead of going straight to the PIN. This is the same rule transfers already follow.
- **A user with a KYC form open at deploy time will be told it expired and sent a new one.** Their old token was never recorded. This happens once.

## Phase 1 — Messenger port

**Status:** completed
**Started:** 2026-09-25
**Completed:** 2026-09-25
**Owner:** Egwu David Samuel

### Deliverables

- [x] `src/messaging/`: an AsyncLocalStorage channel context, the `ChannelMessenger` port, and a WhatsApp adapter that wraps `WhatsappService` and `ChunkedMessengerService` unchanged
- [x] `whatsapp-transport.module.ts`. Onboarding, Manager and Allowance import `MessagingModule` instead of `forwardRef(WhatsappModule)`.
- [x] All 12 sending classes migrated: 179 of 184 call sites mechanically, the rest by hand. Sends outside an inbound event are labelled `transactional` or `proactive`.
- [x] S9 extended so `orchestrator.module.ts` does not reference the port; the messenger and adapter added to S12
- [x] AGENTS.md convention: send only through `ChannelMessenger`

### Acceptance tests

- [x] Goldens and every WhatsApp message unchanged. Every existing spec now builds its service over a real messenger and adapter (`whatsappTestMessenger`) and still asserts the exact `WhatsappService` calls. Full suite: 56 suites, 806 tests.
- [x] The whole app boots with the new module graph (all modules resolved, `/health` 200 against local Postgres). The e2e results match P0's, with the same two stale scenarios.
- [x] A reply with no channel context is reported (`channel-messenger.spec.ts`)

### Progress log

- 2026-09-25: Built as one working-tree change, not one PR per class. Nothing is committed yet; P0 and P1 sit together on `feat/mobile-app-p0`.
- 2026-09-25: A reply with no channel context is **logged**, not thrown as planned. Throwing would turn a missed label on a cron path into a production crash on a money-result message. The warning makes the gap visible without that risk. Specs silence it through `whatsappTestMessenger`.

### Risk

- A missed call site would silently keep sending to WhatsApp for app users. The "throws with no context" rule surfaces this in tests.

## Phase 2 — Identity

**Status:** completed
**Started:** 2026-09-25
**Completed:** 2026-09-25
**Owner:** Egwu David Samuel

### Deliverables

- [x] `User.phoneNumber` (required and unique, backfilled from `whatsappNumber`); `whatsappNumber` made nullable; `lastAppActiveAt`
- [x] `src/common/phone.util.ts`; `findOrCreateUser` links by phone number; Rubies receives `phoneNumber`
- [x] The WhatsApp adapter drops, with a log, any send to a user with no WhatsApp number

### Acceptance tests

- [x] A first WhatsApp message from a number that already has an account links to it rather than creating a second one, and a racing insert reuses the winner's row: `whatsapp-router.service.spec.ts`, "who the sender is". The app-sign-up side of the race is P3's to test.
- [x] Every way of writing a Nigerian number normalises to the WhatsApp sender id: `phone.util.spec.ts`
- [x] Migration verified: an empty `migrate diff` against a shadow database, and applied locally over 13 existing users (13 backfilled, 0 missing)
- [x] Full suite 57 suites, 829 tests. Security check, build and e2e as in P0 (14 pass, the same 2 stale failures). The 11 users e2e created all have `phoneNumber = whatsappNumber`.

### Progress log

- 2026-09-25: Built and verified.

### Risk

- Recycled Nigerian numbers: a new owner of an old number inherits nothing until they pass the P3 checks, which the ADR covers.

## Phase 3 — Authentication

**Status:** completed
**Started:** 2026-09-25
**Completed:** 2026-09-25
**Owner:** Egwu David Samuel

### Deliverables

- [x] `AuthOtp`, `Device`, `AppSession` and `LoginChallenge` tables (migration `20260925170000_app_sign_in`)
- [x] Termii `SmsService` with `SMS_DRY_RUN`, and a daily cap that alerts through Sentry
- [x] Opaque tokens stored as hashes, with refresh rotation and reuse detection
- [x] `AppApiModule`, loaded only when `APP_API_ENABLED=true`, with a global deny-by-default `AppAuthGuard` and `@Public()`
- [x] Session-keyed throttling (`AppThrottlerGuard`) and `trust proxy`
- [x] New-device step-up as set out in ADR-0002: PIN, or WhatsApp approval, or none for a new or app-only user. Other channels and email are told about a new device.
- [x] Invariants S14, S15 and S16 in `check-security.js` and `SECURITY.md`
- [x] Env validation: once the API is on, boot requires the pepper, and the Termii credentials unless SMS is dry-run

### Acceptance tests

- [x] Unit: the OTP caps, attempt budget, supersession and cross-number binding; token rotation, reuse revoking the family and the parallel-refresh race; the guard's deny-by-default and path casing; each step-up branch. 66 suites, 912 tests.
- [x] E2E against a real server with the API on (`e2e/scenarios/app/`): new-number sign-in, logout; deny-by-default including `/V1/ME` casing; PIN step-up with wrong PIN, single-use challenge and refresh rotation; WhatsApp step-up approved through a real button webhook, landing on the same account. 18 pass, plus the 2 stale ones from P0.
- [x] No code, PIN, token, pepper or app phone number in the server log across the run
- [x] `check-security` catches a planted logger in a controller, a controller outside `v1`, and a stray `@Public()`

### Progress log

- 2026-09-25: User decisions: new devices get a 24-hour transfer cap (enforced where app-originated transfers exist, P4 and P7, default ₦20,000 via env); Termii built dry-run, keys added by the user later; each finished phase is committed.
- 2026-09-25: e2e exposed that `AllExceptionsFilter` flattened every `HttpException` body to `{ statusCode, message }`, so the app could not see `attemptsLeft`, `retryAfter` or `lockedUntil`. It now passes deliberate bodies through and still reduces unexpected errors to a generic 500.
- 2026-09-25: Found while writing the new-device email: no email template escapes interpolated values (Rubies recipient names, for one). The new template escapes; the others are recorded in Deferred.

### Risk

- SMS pumping and cost abuse. SIM-swap takeover of an account that has no PIN yet.

## Phase 4 — In-app conversation

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] `AppMessage` table and app adapter; `ConversationRouterService` extracted from the WhatsApp router
- [ ] Async `ChatController`, `POST /v1/chat/start`, and a check that the button tapped was actually offered
- [ ] `/v1/forms/kyc` and `/v1/forms/pin` going through the existing handlers, with values kept in memory only
- [ ] Drafts tagged by channel, a per-user turn lease, a channel-aware rate limit, S15, and an amendment to the AGENTS.md "KYC and PIN only via WhatsApp Flows" rule

### Acceptance tests

- [ ] Sign-up, then chat onboarding, then the KYC form, then PIN setup, end to end in `e2e/scenarios/app/`; another user's button id returns 404

### Progress log

-

### Risk

- A wizard left open on one channel swallowing input from the other.

## Phase 5 — Push and delivery rules

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] `PushService` (Expo); `originChannel`; the delivery policy wired into the schedulers, the Rubies webhook and reconciliation

### Acceptance tests

- [ ] No double alerts; nothing sent to WhatsApp outside the 24-hour window without a template

### Progress log

-

### Risk

- Silent failures on Meta's side when routing gets it wrong.

## Phase 6 — Native read-only API

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] `/v1/me`, balance, limits, account, transactions (new `TransactionHistoryService`), recipients, banks, name enquiry (rate-limited), spend summary, bill catalog, app config; OpenAPI served outside production only

### Acceptance tests

- [ ] Every endpoint returns only the caller's own data

### Progress log

-

### Risk

- Name enquiry being used to look up who owns an account. It is rate-limited per user.

## Phase 7 — Native transfers

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] Tests that pin the exact WhatsApp messages first. Then `createQuote` and `evaluateConfirm` return data, with a WhatsApp renderer on top. `/v1/transfers` with `Idempotency-Key`. `clientRequestKey`, `originSurface`, S17.

### Acceptance tests

- [ ] Quote, then confirm, then PIN, then `EXECUTED` in dry run; a replayed idempotency key returns the original

### Progress log

-

### Risk

- This refactors the file S7 guards. A reordered guard is the failure to fear.

## Phase 8 — Native bills

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] The P7 pattern applied to `bill-payment-confirmation.service.ts`

### Acceptance tests

- [ ] Same as P7, for airtime, data and electricity

### Progress log

-

### Risk

- Same as P7.

## Phase 9 — Account and compliance

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] Device list and revoke, settings requests, email verification (required for PIN reset from then on), account deletion request, terms re-consent check

### Acceptance tests

- [ ] A PIN reset is refused until the email is verified; a deletion request needs a zero balance

### Progress log

-

### Risk

- The deletion and retention policy is still an open decision (see ADR-0002).

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Paperwork and WhatsApp-neutral fixes | completed |
| 1 | Messenger port | completed |
| 2 | Identity | completed |
| 3 | Authentication | completed |
| 4 | In-app conversation | not started |
| 5 | Push and delivery rules | not started |
| 6 | Native read-only API | not started |
| 7 | Native transfers | not started |
| 8 | Native bills | not started |
| 9 | Account and compliance | not started |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Deferred

- Email templates interpolate values unescaped (e.g. Rubies recipient names in `moneyOutEmail`). Use `escapeHtml` from `email.templates.ts` everywhere.
- A returning install is always a new device (no device-bound key yet), so signing out and back in repeats step-up and restarts the new-device cap. A Keychain/Keystore key pair signing a challenge would fix this.
- Two stale e2e scenarios that fail on `main` too:
  - `inbound.media.unsupported-image` expects the pre-vision "can't do anything with that" reply. Images now go to download plus the orchestrator, and media download is not dry-run, so it fails locally.
  - `transfer.wizard.amount-then-account` expects "transfer" to open the wizard directly. Free text now goes through the orchestrator, which falls back to the menu under `AI_PROVIDER=stub`.
- Local development safety: `.env` points at the hosted database, and the e2e runner inherits it. Point `.env` at the docker Postgres, or give the e2e runner its own `E2E_DATABASE_URL` by default.
- Voice notes and images from the app
- Prompt and golden changes to drop "WhatsApp bubble" wording
- An operator console for settings and deletion requests

## Decisions

- [ADR-0002](../../docs/decisions/0002-app-channel-and-auth.md): the app as a second channel, SMS one-time-code auth, new-device step-up, and the change to the "KYC and PIN only via WhatsApp Flows" constraint.
- Settled 2026-09-25: a 24-hour transfer cap on newly trusted devices, enforced when app-originated transfers land (P4 chat, P7 native).
- Still open, to settle before the phase that needs them:
  - the account deletion and retention policy, checked against the Rubies agreement and the NDPA (P9);
  - a Termii account, API key and an approved "dnd" sender ID, before `APP_API_ENABLED` is turned on anywhere real.
