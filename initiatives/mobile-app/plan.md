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

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] `User.phoneNumber` (required and unique, backfilled from `whatsappNumber`); `whatsappNumber` made nullable; `lastAppActiveAt`
- [ ] `src/common/phone.util.ts`; `findOrCreateUser` links by phone number; Rubies receives `phoneNumber`

### Acceptance tests

- [ ] An existing WhatsApp user and an app sign-up with the same number end up as one `User`, whichever arrives first, including when they race

### Progress log

-

### Risk

- Recycled Nigerian numbers: a new owner of an old number inherits nothing until they pass the P3 checks, which the ADR covers.

## Phase 3 — Authentication

**Status:** not started
**Started:**
**Completed:**
**Owner:**

### Deliverables

- [ ] `AuthOtp`, `Device` and `AppSession` tables; Termii `SmsService` with a dry-run mode and a daily cap; opaque hashed tokens with refresh rotation
- [ ] A global deny-by-default `AppAuthGuard` with `@Public()`; per-user and per-phone throttling; `trust proxy`
- [ ] New-device step-up as set out in ADR-0002; S14 and S16

### Acceptance tests

- [ ] Unauthenticated `/v1` returns 401; OTP brute force locks out; reusing a refresh token revokes the family; a new device with a PIN on file needs the PIN

### Progress log

-

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
| 2 | Identity | not started |
| 3 | Authentication | not started |
| 4 | In-app conversation | not started |
| 5 | Push and delivery rules | not started |
| 6 | Native read-only API | not started |
| 7 | Native transfers | not started |
| 8 | Native bills | not started |
| 9 | Account and compliance | not started |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Deferred

- Two stale e2e scenarios that fail on `main` too:
  - `inbound.media.unsupported-image` expects the pre-vision "can't do anything with that" reply. Images now go to download plus the orchestrator, and media download is not dry-run, so it fails locally.
  - `transfer.wizard.amount-then-account` expects "transfer" to open the wizard directly. Free text now goes through the orchestrator, which falls back to the menu under `AI_PROVIDER=stub`.
- Local development safety: `.env` points at the hosted database, and the e2e runner inherits it. Point `.env` at the docker Postgres, or give the e2e runner its own `E2E_DATABASE_URL` by default.
- Voice notes and images from the app
- Prompt and golden changes to drop "WhatsApp bubble" wording
- An operator console for settings and deletion requests

## Decisions

- [ADR-0002](../../docs/decisions/0002-app-channel-and-auth.md): the app as a second channel, SMS one-time-code auth, new-device step-up, and the change to the "KYC and PIN only via WhatsApp Flows" constraint.
- Still open, to settle before the phase that needs them:
  - a lower transfer cap on newly added devices (P3);
  - the account deletion and retention policy, checked against the Rubies agreement and the NDPA (P9);
  - registering a Termii sender ID (before P3 goes live).
