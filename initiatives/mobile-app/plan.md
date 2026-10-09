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

**Status:** completed
**Started:** 2026-09-26
**Completed:** 2026-09-26
**Owner:** Egwu David Samuel

### Deliverables

- [x] `AppMessage` table (inbound text scrubbed with `scrubFreeTextSecrets` before it is stored) and `AppChannelAdapter`, which writes a row per bubble and wakes long-polls
- [x] `ConversationRouterService` extracted from `WhatsappRouterService`. It handles text, a button or list choice, a PIN form and a KYC form, for either channel. The WhatsApp router keeps only webhook parsing, media, user lookup, the rate check and sign-in approval buttons.
- [x] `TurnService`: one turn per user at a time across channels and replicas (a `UserTurnLease` row claimed with conditional writes). When a turn arrives on a different channel from the last one, open transfer and bill drafts, a pending beneficiary pick and a weekly-review limit wait are quietly expired.
- [x] `/v1/chat`: `POST messages` (202, idempotent on `clientMessageId`), `GET messages` (cursor plus long-poll), `POST start`. A choice must name a buttons or list message sent to the same user that offered that id, or it is a 404.
- [x] `/v1/forms/kyc` and `/v1/forms/pin` (202). They feed the existing handlers through the in-memory `sensitive` map; the stored row records only which form was submitted.
- [x] The inbound rate limit counts WhatsApp and app messages together
- [x] An app-only user without a PIN is asked for one straight after KYC, and onboarding does not continue until it is set (ADR-0002)
- [x] The new-device transfer cap (ADR-0002): a PIN approved from an app device trusted less than 24 hours ago cannot move more than `NEW_DEVICE_TRANSFER_CAP` (default ₦20,000) in total since that device was trusted. Enforced in `PinOutcomeService`, the one place a verified PIN moves money.
- [x] With no channel context, a user with no WhatsApp number is sent to the app instead of being dropped. The full delivery policy is still P5.
- [x] Onboarding copy that mentions WhatsApp has an app version, chosen by channel. The WhatsApp text is unchanged.
- [x] S15 extended; the new security-critical files added to S12; the AGENTS.md "KYC and PIN only via WhatsApp Flows" rule amended

### Acceptance tests

- [x] E2E, app only: sign-in, `chat/start`, intro and terms by button, the KYC form, the PIN setup form, then the money-story questions. No ID number or PIN in any `AppMessage` row.
- [x] E2E: another user's message id, or an id the message did not offer, returns 404; a repeated `clientMessageId` is not processed twice
- [x] Unit: the WhatsApp router spec still passes against the extracted router, with only construction changed
- [x] Unit: lease contention, expiry and channel-switch expiry; the choice-offered check; the cap's boundaries; the post-KYC PIN gate. Full suite: 74 suites, 1005 tests.
- [x] Existing e2e: the same pass and fail set as P3. 20 pass (6 app scenarios among them), 3 skipped by design, and the same 2 stale failures. One fixture changed; see the progress log.
- [x] No ID number, date of birth, PIN, email, chat text, pepper or token in the server log across the e2e run
- [x] `check-security` catches a planted `JSON.stringify` in an app service, a phone number in a query DTO, and a removed app-chat scrub (S5)

### Progress log

- 2026-09-26: Designed. Two departures from the outline, both recorded in the tech design:
  - Drafts are not tagged with a channel. The lease row records the channel of the user's last turn, and a switch expires whatever is open. This has the same effect without touching the nine draft-creation sites in the transfer wizard.
  - `PinFlowOutcome` is not widened. The app's form screens submit and return to the chat, where the outcome arrives as it does on WhatsApp (success, or the reason and a fresh form). Native money screens need structured results, which P7 builds.

- 2026-09-26: Built and verified.
- 2026-09-26: e2e showed the lease working as designed and exposed a race in an existing fixture. `provisionNewUser` seeded a user as fully onboarded as soon as the first outbound bubble appeared, while the server's introduction turn was still sending and was about to set the stage to WELCOME. Before the lease, the scenario's next message was handled concurrently and got in first; now it waits for the turn and sees the stage that turn left. The fixture now waits for the opening message to be handled before seeding (`waitForInboundSettled`). No scenario changed.
- 2026-09-26: Fixed a dry-run defect found on the way: outbound dry-run ids were `wamid.dryrun.<milliseconds>`, so two sends in the same millisecond collided on the unique `waMessageId` and failed the turn. They are now random. Dry-run only.
- 2026-09-26: Local e2e needs `DEEPGRAM_API_KEY=` blank on the server. With a key, a voice note is downloaded from Meta for real (media download is not dry-run) and the audio scenario fails.
- 2026-09-26: The new-device cap message does not suggest sending from WhatsApp instead. Someone holding a swapped SIM can re-register WhatsApp too, so that would be advice on getting around the cap. A WhatsApp PIN is not capped at all, for the same reason it cannot be: WhatsApp gives no device to key on. Recorded in Deferred.

### Risk

- A wizard left open on one channel swallowing input from the other. The channel-switch expiry addresses this.
- A slow turn makes the user's next message wait for it. The wait is capped, after which the turn runs anyway, as it does today.

## Phase 5 — Push and delivery rules

**Status:** completed
**Started:** 2026-09-26
**Completed:** 2026-09-26
**Owner:** Egwu David Samuel

### Deliverables

- [x] `decideDelivery`: a pure function that decides where a message sent outside any user's turn goes. The rules are in the tech design.
  - Money results follow the channel the payment started on.
  - Credits, check-ins and the managers' replies follow the channel the user last used.
  - WhatsApp is used only while Meta's 24-hour window is open, unless the user has no app to fall back to.
  - Whatever reaches WhatsApp is also written to the app chat (silently) for anyone who has signed in to the app.
  - Anything that lands only in the app raises a push.
- [x] `ChannelMessenger` applies it. A send can also pin a channel: sign-in approvals and new-device warnings are pinned to WhatsApp, because only WhatsApp answers those buttons and the warning must reach a channel other than the new phone.
- [x] `PushService` (Expo push API, `PUSH_DRY_RUN`):
  - One push per device per minute, so a multi-bubble message is one alert.
  - Generic text only, never amounts, names or account numbers.
  - Only to devices with a live session.
  - A token Expo reports as `DeviceNotRegistered` is dropped.
- [x] `POST` and `DELETE /v1/devices/push-token`. Registering a token takes it off any other device row holding it, so a phone that changes hands stops getting the previous user's alerts.
- [x] `Transaction.originChannel` and `BillPayment.originChannel`, set from the channel context when the quote is made
- [x] The allowance nudge asks the policy first, and uses a WhatsApp template only when the message is actually going to WhatsApp
- [x] S14: sign-in approvals and warnings must stay pinned to WhatsApp

### Acceptance tests

- [x] Unit: every branch of the delivery rules; a pinned channel beats both the context and the policy; one push for a burst of messages; no amount in any push body; token hand-over clears the other device
- [x] E2E: a credit for an app-only user lands in the app chat and raises one push. A credit for a WhatsApp user who is inside the window goes to WhatsApp, is mirrored to the app, and raises no push.
- [x] WhatsApp-only users (no device) get exactly what they get today, including outside the window. The test messenger reproduces that routing, and every existing spec still asserts unchanged WhatsApp output. Full suite: 78 suites, 1042 tests.
- [x] Full e2e: 21 pass, 3 skipped by design, and the same 2 stale failures. Three back-to-back runs of the app scenarios were clean.
- [x] Server log: no PIN, pepper, session token, push token or payment reference. Dry-run push lines name only the device.
- [x] `check-security` catches a sign-in message that is no longer pinned to WhatsApp

### Progress log

- 2026-09-26: Designed. One refinement of the outline's acceptance wording ("nothing sent to WhatsApp outside the 24-hour window without a template"). For someone with the app, a message that would hit a closed window goes to the app and raises a push instead. For a WhatsApp-only user there is nowhere else to send it, so their behaviour is unchanged; a template for transactional messages would be needed, and none is approved.

- 2026-09-26: Built and verified.
- 2026-09-26: `Device.pushToken` is unique, in its own migration (`20260926151000_push_token_unique`). While adding it I ran `prisma migrate reset --force` on the local docker database, which wiped its data; it was local only, and the migrations re-applied cleanly. The index then went into a new migration rather than an edited one.
- 2026-09-26: e2e helper fixes. `waitForInboundSettled` now waits for the message to exist as well as to be handled; the webhook acks before recording. `verifyCode` presents a fresh client address, as `requestCode` already did; with more sign-ins per run, back-to-back runs from localhost hit the sign-in throttle. New `postSignedRubiesWebhook` signs credits with the shared secret.
- 2026-09-26: Not built, deferred: Expo push receipts (the second step that reports delivery failures after the send is accepted). Tickets already drop `DeviceNotRegistered` tokens.

### Risk

- Silent failures on Meta's side when routing gets it wrong.
- A push to a phone that has changed hands. The token hand-over and the live-session requirement cover this.

## Phase 6 — Native read-only API

**Status:** completed
**Started:** 2026-09-26
**Completed:** 2026-09-26
**Owner:** Egwu David Samuel

### Deliverables

Every route is signed-in only and reads only the caller's own rows, except `app-config`. Shapes are in the tech design.

- [x] `GET /v1/me` also says whether the account exists (`hasAccount`)
- [x] `GET /v1/balance`: the live Rubies balance, never a cached figure. 409 `no_account` before the account exists; 503 `balance_unavailable` when Rubies does not answer.
- [x] `GET /v1/limits`: remaining today and this week, and the window (open, opens in how long, restrictions off). The window and restrictions-off logic moves out of `AccountActionsService.sendLimitsStatus` into a shared `describeLimits`, so the WhatsApp reply and the screen cannot disagree. The WhatsApp text is unchanged.
- [x] `GET /v1/account`: account number and name, and the bank, for funding
- [x] `GET /v1/transactions?cursor=&limit=`: one history of transfers, bill purchases and money received, newest first, from a new `TransactionHistoryService`.
  - Shows only what has been committed to (confirmed, done or failed). Quotes and cancellations are left out.
  - The cursor is opaque and stable while new rows arrive.
  - New indexes so each source is read in order: `BillPayment(userId, createdAt)` and `IncomingCredit(userId, creditedAt)`.
- [x] `GET /v1/recipients`: saved recipients, most recently used first
- [x] `GET /v1/banks`: the bank list, cached in memory for 6 hours. An empty answer from Rubies is not cached and returns 503.
- [x] `POST /v1/name-enquiry {accountNumber, bankCode}`: who owns an account, before sending to it.
  - At most 20 per user per rolling hour, counted in the database (new `NameEnquiryLog`: user and time only, never the account looked up), so neither a token refresh nor a restart resets it.
  - Needs an account, so a phone that has only signed up cannot use it.
- [x] `GET /v1/spend-summary?period=week|month`: the same figures as the weekly check-in (`SpendSummaryService`)
- [x] `GET /v1/bills/catalog`: airtime networks, data networks and bundles, electricity companies, and the amount bounds, from the existing catalog
- [x] `GET /v1/app-config`, public: the oldest app version the server still supports (`APP_MIN_SUPPORTED_VERSION`, optional). S14's public list gains this one file.
- [x] OpenAPI (`@nestjs/swagger` 7.4, the Nest 10 line) at `/docs` only when `APP_API_DOCS=true`, which is off by default and never set in a deployed environment. The CLI plugin reads the DTOs, so there is no second copy of the shapes to keep in step.

### Acceptance tests

- [x] Unit: history merge order across the three sources, cursor paging with no gaps or repeats (including rows with the same timestamp), a tampered cursor is a 400, and quotes and cancelled rows never appear
- [x] Unit: `describeLimits` covers restrictions off, window open and window closed; the WhatsApp limits text is byte-for-byte unchanged
- [x] Unit: name enquiry is refused on the 21st call in an hour, and the log row holds no account number
- [x] Unit: the bank cache does not keep an empty list, and concurrent misses make one Rubies call
- [x] E2E: a signed-in user sees their own balance, limits, account and history, and none of another user's rows. Every new route is 401 without a session, except `app-config`.
- [x] `check-security` fails on a `@Public()` anywhere else
- [x] Full suite: 88 suites, 1100 tests. E2E: 22 pass, 3 skipped by design, and the same two stale failures.
- [x] Server log: no account number looked up, recipient name, electricity token, session token or pepper
- [x] The OpenAPI document lists all 25 routes, with no untyped fields; `/docs` is not mounted unless both `APP_API_ENABLED` and `APP_API_DOCS` are `true`

### Progress log

- 2026-09-26: Designed. Amounts are naira as JSON numbers, as everywhere else in the codebase. The spend summary covers transfers only, as the weekly check-in does. Bills are in the history but not the summary; counting them would change the check-in too, so that is left for later.
- 2026-09-26: Built and verified.
- 2026-09-26: `@nestjs/swagger` 7.4.2 added (no install scripts). `npm audit` flags the `js-yaml` it brings; every advisory is in YAML parsing, which swagger never does with request input. Recorded in SECURITY.md §6.
- 2026-09-26: Two things beyond the design. The bank cache answers from what it holds for a minute after an empty reply, so a Rubies outage does not make each history page wait out a 30-second timeout. Prisma enums and string unions in the views carry `@ApiProperty({ enum })`, including P3's `DeviceDto.platform`, because the plugin cannot see types.
- 2026-09-26: The existing WhatsApp limits tests only checked fragments, so exact-text tests were added and run against the code before the extraction as well as after.

### Risk

- Name enquiry being used to look up who owns an account. It is limited per user in the database and needs an opened account, which needs a verified identity.
- The history reads three tables per page. Per-user volumes are small and each read is an index range.

## Phase 7 — Native transfers

**Status:** completed
**Started:** 2026-09-26
**Completed:** 2026-09-26
**Owner:** Egwu David Samuel

### Deliverables

- [x] First, tests that pin today's exact WhatsApp output (text, buttons and order) for every quote, confirm and cancel branch, run green against the code before the refactor
- [x] `TransferConfirmationService` split so decisions return data:
  - `createQuote` returns the quote (or no account, or recipient not verified);
  - `evaluateConfirm` returns a decision: balance unavailable, not enough money, re-quoted, PIN setup needed, locked, or ready for the PIN;
  - `initiateTransfer` and `confirmTransfer` are those plus the unchanged WhatsApp rendering;
  - `executeVerifiedTransfer` and `applyTransferResult` are not touched.
- [x] `PinGateService`: a PIN token can be issued without sending a form, and a transfer PIN can be checked with a structured answer (verified, wrong with a fresh token, locked, expired) instead of chat messages. The WhatsApp handling is the same code path with its messages on top.
- [x] `PinOutcomeService.apply` reports when the new-device cap refused a payment, and can skip the chat message for a caller that shows it itself
- [x] `Transaction.originSurface` (`CHAT` or `NATIVE`) and `clientRequestKey`, unique per user. Native quotes are invisible to the chat: resuming, cancelling, the orchestrator's "pending confirm" context, and the chat's own confirm and cancel buttons skip them.
- [x] Routes, all signed-in and scoped to the caller:
  - `POST /v1/transfers` with a required `Idempotency-Key` header: the quote. A replayed key returns the same transfer; the same key with a different request is refused.
  - `POST /v1/transfers/:id/confirm`: the decision. When the answer is the PIN, it carries a PIN token. Asking again while the PIN is awaited issues a fresh token, so a dropped response is recoverable.
  - `POST /v1/transfers/:id/authorize {pinToken, pin}`: the PIN, answered synchronously: sent, processing, failed, wrong PIN (with a fresh token), locked, over the new-device limit, or expired.
  - `GET /v1/transfers/:id` and `POST /v1/transfers/:id/cancel`
- [x] Native transfers write no quote card and no PIN form into the chat. Their results are delivered like any payment's: into the app chat, with a push when the result comes later from Rubies.
- [x] S17: `executeVerifiedTransfer` and `executeVerifiedBillPayment` are called only from `pin-outcome.service.ts`, and a native route that creates a payment reads an `Idempotency-Key`

### Acceptance tests

- [x] The pinned WhatsApp-output tests pass unchanged after the refactor, as does the rest of the transfer, PIN gate and PIN outcome suites
- [x] Unit: every confirm decision; a native quote is ignored by every chat path; a PIN token for one transfer cannot authorize another; a wrong PIN answers with a fresh token and a locked PIN cancels the transfer
- [x] E2E: quote, confirm, PIN, then `EXECUTED` in dry run, with the result in the app chat and no quote card or PIN form there; a replayed key returns the original transfer and creates nothing; a different request under the same key is refused; another user's transfer id is a 404 on every route; a wrong PIN then the right one with the fresh token succeeds
- [x] `check-security` fails on an execute call outside `pin-outcome.service.ts`, and on the create route losing its idempotency key
- [x] Full suite: 90 suites, 1183 tests. E2E: 23 pass, 3 skipped by design, and the same two stale failures.
- [x] Server log: no PIN, PIN token, idempotency key, account number or recipient name

### Progress log

- 2026-09-26: Designed. The open question from P4, whether to cap WhatsApp PINs too, is left as it is: capping WhatsApp "after a new app sign-in" would not catch a SIM swap, which re-registers WhatsApp without any app sign-in. It still needs a re-registration signal Meta does not give, and stays in Deferred.
- 2026-09-26: The pinned WhatsApp-output tests (16) pass against the code before the refactor.
- 2026-09-26: Built and verified. The 16 pinned tests pass unchanged after it; the older transfer tests needed only `originSurface: "CHAT"` added to their fixtures, no assertion changes.
- 2026-09-26: One ordering change inside the PIN gate: on a lockout, the transfer is now cancelled just before the "locked" message is sent rather than just after. Nothing the user sees changes.
- 2026-09-26: `PinGateService` and `PinOutcomeService` are now exported from `WhatsappModule` for the native routes. Planted violations (an execute call in the native service; the create route reading a different header) both fail `check-security` under S17.
- 2026-10-09: Fixed after the phase, found while designing P8. A native quote to a recipient not yet saved asks the bank for their name and returns it, which is exactly what P6's name enquiry does, but it did not spend from P6's 20-an-hour lookup budget. The quote route was therefore a lookup with only the general 300-a-minute throttle on it. It now spends one lookup first (refused with 429 `too_many_lookups` once the budget is gone), checks for an account before spending, and the quote route has its own limit of 20 a minute. E2E: after 20 name enquiries, a quote to a new recipient is refused and creates nothing.
- 2026-09-26: Not built: showing the new-phone limit at quote time. It is enforced after the PIN, as for the chat; telling the user before they confirm would be kinder, and is a small follow-up.

### Risk

- This refactors the file S7 guards. A reordered guard is the failure to fear, which is what the pinned-output tests and the unchanged guard order in `evaluateConfirm` are for.
- A native quote left waiting is not cancelled by anything in the chat. It cannot move money without a confirm and a PIN, and a confirm more than 10 minutes later is re-quoted.

## Phase 8 — Native bills

**Status:** completed
**Started:** 2026-10-09
**Completed:** 2026-10-09
**Owner:** Egwu David Samuel

### Deliverables

- [x] First, tests that pin today's exact WhatsApp output for every bill quote, confirm and cancel branch, for airtime, data and electricity, run green against the code before the refactor
- [x] `BillPaymentConfirmationService` split the way P7 split transfers:
  - `createQuote` and `evaluateConfirm` return what was decided;
  - `initiateBillPayment` and `confirmBillPayment` render it as before;
  - `executeVerifiedBillPayment` and `applyBillPaymentResult` are not touched.
- [x] `PinGateService`: a bill PIN token can be issued without a form and checked as data, sharing one check with the chat's bill PIN form and with P7's transfer check
- [x] `BillPayment.originSurface` and `clientRequestKey`, unique per user. Native purchases are invisible to the chat's confirm and cancel buttons, its resume and cancel paths, and the orchestrator's "pending confirm" context.
- [x] Routes under `/v1/bills`, all signed-in and scoped to the caller, next to P6's catalog:
  - `POST /v1/bills` with a required `Idempotency-Key`: the quote, for airtime, a data bundle or prepaid electricity. The server takes the network, bundle, electricity company and amount bounds from the catalog, never from the request. A data bundle's price is the catalog's, and an `amount` sent with one is refused. A replayed key returns the same purchase; the same key with a different request is refused.
  - Electricity: the server checks the meter with Rubies at quote time and puts the name it returns on the quote. The check spends one lookup from the same hourly budget as account-name lookups.
  - `POST /v1/bills/:id/confirm`, `/authorize`, `/cancel` and `GET /v1/bills/:id`, as for transfers. A successful electricity purchase carries its token.
- [x] Native purchases write no quote card or PIN form into the chat; their results arrive there like any payment's
- [x] S17 covers the bills route: it must read an `Idempotency-Key`

### Acceptance tests

- [x] The pinned WhatsApp-output tests pass unchanged after the refactor, as does the rest of the bill, PIN gate and PIN outcome suites
- [x] Unit: every confirm decision for bills; a native purchase is ignored by every chat path; a PIN token for one purchase cannot authorize another, or a transfer; the catalog is the only source of codes, labels, bundle prices and bounds; the meter check spends a lookup and a failed one is a 422
- [x] E2E: airtime, data and electricity quoted natively; electricity confirmed, PIN entered, `EXECUTED` in dry run with its token, the result in the app chat and no card or PIN form there; replay and key reuse as for transfers; another user's purchase id is a 404 on every route; `GET /v1/bills/catalog` still answers
- [x] `check-security` fails when the bills create route stops reading its idempotency key
- [x] Full suite: 91 suites, 1282 tests. E2E: 24 pass, 3 skipped by design, and the same two stale failures.
- [x] Server log: no PIN, PIN token, electricity token, idempotency key, meter number, phone number or meter holder's name

### Progress log

- 2026-10-09: Designed. Before starting, fixed a P7 gap the meter check would have repeated: a native transfer quote to a new recipient did not spend from the lookup budget (commit `9d173b4`).
- 2026-10-09: The pinned WhatsApp-output tests (19) passed against the code before the refactor, and pass unchanged after it.
- 2026-10-09: Built and verified. The older bill tests needed `originSurface: "CHAT"` on their fixtures, and one assertion changed on purpose: `cancelPendingForUser`'s exact query now also filters to chat purchases.
- 2026-10-09: `PinGateService` now has one PIN check (`checkPaymentPin`) for all four paths: the chat's transfer and bill forms and both native routes. `TransferPinCheck` is renamed `PaymentPinCheck`. As for transfers in P7, a bill PIN lockout now cancels the purchase just before the "locked" message rather than just after.
- 2026-10-09: The status, decision and result vocabulary, the re-quote and cap shapes, and the small helpers (`naira`, the channel-context wrapper, the fee note, the unique-violation check) moved to `app-api/payment.view.ts` and `app-api/payments.util.ts`; P7's files use them with no change in behaviour (all 47 transfer tests pass).
- 2026-10-09: A planted violation (the bills create route reading a different header) fails `check-security` under S17.

### Risk

- Same as P7: this refactors the file whose guards stop a purchase without a PIN. The pinned-output tests and the unchanged guard order are the defence.
- A meter check reveals the name on a meter. It spends from the same budget as account-name lookups, and needs an opened account.

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
| 4 | In-app conversation | completed |
| 5 | Push and delivery rules | completed |
| 6 | Native read-only API | completed |
| 7 | Native transfers | completed |
| 8 | Native bills | completed |
| 9 | Account and compliance | not started |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Deferred

- Email templates interpolate values unescaped (e.g. Rubies recipient names in `moneyOutEmail`). Use `escapeHtml` from `email.templates.ts` everywhere.
- A returning install is always a new device (no device-bound key yet), so signing out and back in repeats step-up and restarts the new-device cap. A Keychain/Keystore key pair signing a challenge would fix this.
- Two stale e2e scenarios that fail on `main` too:
  - `inbound.media.unsupported-image` expects the pre-vision "can't do anything with that" reply. Images now go to download plus the orchestrator, and media download is not dry-run, so it fails locally.
  - `transfer.wizard.amount-then-account` expects "transfer" to open the wizard directly. Free text now goes through the orchestrator, which falls back to the menu under `AI_PROVIDER=stub`.
- Local development safety: `.env` points at the hosted database, and the e2e runner inherits it. Point `.env` at the docker Postgres, or give the e2e runner its own `E2E_DATABASE_URL` by default.
- The new-device cap covers PINs entered in the app only. A SIM swap can also re-register WhatsApp, and WhatsApp PINs are not capped. Capping WhatsApp after a new app device was considered in P7 and not done: a SIM swap re-registers WhatsApp without any app sign-in, so it would not catch the case it is for. This needs a re-registration signal, which Meta does not report.
- `AppMessage.seq` comes from a Postgres sequence, assigned at insert rather than at commit, so two concurrent inserts for one user could become visible out of order and a poll could step past one. Turns are serialized per user, so only a proactive send racing a turn could do this. Revisit with P5's delivery policy.
- Expo push receipts: fetch them after a send to catch tokens that fail after acceptance
- Show the new-phone limit on a native quote, before the user confirms (it is enforced after the PIN)
- A WhatsApp template for transactional messages (money in and out), so WhatsApp-only users outside the 24-hour window are reached. Needs a Meta-approved template.
- Voice notes and images from the app
- Prompt and golden changes to drop "WhatsApp bubble" wording
- An operator console for settings and deletion requests

## Decisions

- [ADR-0002](../../docs/decisions/0002-app-channel-and-auth.md): the app as a second channel, SMS one-time-code auth, new-device step-up, and the change to the "KYC and PIN only via WhatsApp Flows" constraint.
- Settled 2026-09-25: a 24-hour transfer cap on newly trusted devices, enforced when app-originated transfers land (P4 chat, P7 native).
- Still open, to settle before the phase that needs them:
  - the account deletion and retention policy, checked against the Rubies agreement and the NDPA (P9);
  - a Termii account, API key and an approved "dnd" sender ID, before `APP_API_ENABLED` is turned on anywhere real.
