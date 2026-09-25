# Mobile app backend: tech design

Companion to [`initiatives/mobile-app/plan.md`](../../initiatives/mobile-app/plan.md) and [`docs/specs/MOBILE_APP_SPEC.md`](../specs/MOBILE_APP_SPEC.md).

## Links

- Spec: [MOBILE_APP_SPEC.md](../specs/MOBILE_APP_SPEC.md)
- Plan: [initiatives/mobile-app/plan.md](../../initiatives/mobile-app/plan.md)
- ADR: [0002-app-channel-and-auth.md](../decisions/0002-app-channel-and-auth.md)

## Approach

The app is a second **channel** into the same engine, not a second product.

1. **Messenger port (P1).**
   - Every class that sends today (`OnboardingService`, the wizards, the confirmation services, `PinGateService`, the schedulers and the Rubies webhook) sends through a `ChannelMessenger` addressed by `User`.
   - A WhatsApp adapter reproduces today's output exactly.
   - An app adapter (P4) writes `AppMessage` rows and triggers push.
   - The channel comes from an AsyncLocalStorage context set per inbound event. Sends with no context (crons, webhooks) follow a delivery policy (P5).
2. **Structured money decisions (P7, P8).**
   - Native screens need data, not chat messages, from quote and confirm.
   - Only those decision points are refactored to return results, with a WhatsApp renderer on top.
   - Execution (`executeVerifiedTransfer`, `applyTransferResult`) is not touched.
3. **Everything else is reuse:**
   - `AllowanceService`, `WindowService`, `FeeCalculatorService`
   - `SpendSummaryService`, `TaggingService`
   - `ManagerService`, `PinService`, `RubiesService`
   - `OrchestratorService`, `ActionValidatorService`

P0, below, is the part built so far. It changes no module wiring beyond one new provider.

## Data / types

**P0**
- `OnboardingSession.kycFlowToken String?`. Migration `20260925120000_kyc_flow_token`.

**Later**, designed in their phases:
- `User.phoneNumber @unique`, `User.lastAppActiveAt`, and `whatsappNumber` made nullable (P2)
- `AuthOtp`, `Device`, `AppSession` (P3)
- `AppMessage` and `UserTurnLease` (P4)
- `originChannel` on `Transaction` and `BillPayment` (P5)
- `clientRequestKey` and `originSurface` (P7, P8)
- `User.emailVerifiedAt` and `SettingsChangeType.ACCOUNT_DELETION` (P9)

## Control flow

### P0: inbound rate limit

`WhatsappController` → `recordInboundIfNew` (no `userId` yet) → `WhatsappRouterService.route` → `findOrCreateUser` → **`WhatsappMessageService.attachUser(message.id, user.id)`** → `InboundRateLimitService.check(user.id)`.

The count now includes the message being handled, matching how the limit was written (`count <= 40` passes; the 41st sets `justCrossed`).

### P0: scoped confirm and cancel

- `confirmTransfer(userId, id)`, `cancelTransfer(userId, id)`, `confirmBillPayment(userId, id)` and `cancelBillPayment(userId, id)` read with `findUnique({ where: { id, userId } })`. Prisma 5 accepts non-unique filters next to the unique key.
- A row owned by someone else reads as `null`, so it takes the existing "no such row" path.
- The router passes `user.id` from the signed sender. The internal resume paths pass the user they already hold.

### P0: bill confirm

`confirmBillPayment` now follows the same order as `confirmTransfer`:
1. Look up the row (scoped).
2. Live balance check.
3. **Re-quote** if `createdAt` is older than `CONFIRM_RE_QUOTE_AFTER_MS` (now exported from `transfer-confirmation.service.ts`) or `evaluateSpend` gives a different type or fee:
   - conditional `updateMany` of type and fee while `PENDING_CONFIRMATION`;
   - `sendQuoteCard` with a heading line;
   - return. The row stays `PENDING_CONFIRMATION`.
4. PIN setup, if the user has no PIN.
5. Lockout check.
6. Claim `PENDING_PIN`, then request the PIN.

`sendQuoteCard` is shared with `initiateBillPayment`, so a first quote renders byte-for-byte as before.

`cancelBillPayment` claims `PENDING_CONFIRMATION → CANCELLED` through `claimStatus` rather than calling `update`.

`cancelPendingForUser` selects `PENDING_CONFIRMATION` and `PENDING_PIN`, claims each row from its own status, and always messages for a `PENDING_PIN` row, even when silent.

### P0: KYC form token

1. `sendKycFlow` generates the token, writes it to the session, **then** sends the Flow.
2. `handleInboundFlowReply`, after the stage check, claims with `updateMany({ where: { id: session.id, kycFlowToken: token }, data: { kycFlowToken: null } })`.
3. A count of 0 (stale, missing, or lost a race) sends "that form has expired, here's a fresh one:" and a new form, and nothing else runs.
4. Every existing retry path goes through `sendKycFlow`, so every retry issues a fresh token.

### P0: `PinOutcomeService`

`WhatsappRouterService.handleFlowReply` → `PinGateService.handlePinFlowReply` → **`PinOutcomeService.apply(outcome, user.id)`**.

`apply` is the only caller of `executeVerifiedTransfer` and `executeVerifiedBillPayment`, apart from the resume paths inside the confirmation services, which only ever re-request a PIN. P7 turns this into invariant S17.

### P1: messenger port

**Files:**
- `src/messaging/channel-context.ts`: `runInChannel(ctx, fn)` and `currentChannelContext()` over one `AsyncLocalStorage<{ channel: "whatsapp" | "app" }>`.
- `src/messaging/channel-messenger.ts`: `ChannelMessenger`, with `sendText`, `sendButtons`, `sendList`, `sendChunked`, `requestForm` and `sendTemplate`. Each method is addressed by `MessageRecipient = Pick<User, "id" | "whatsappNumber">` and takes optional `{ delivery: "reply" | "transactional" | "proactive" }`.
- `src/messaging/whatsapp-channel.adapter.ts`: maps each call one-to-one onto the `WhatsappService` / `ChunkedMessengerService` call it replaced (number from `to.whatsappNumber`, `userId` from `to.id`). `requestForm` resolves the Flow id from `WHATSAPP_{KYC,PIN_ENTRY,PIN_SETUP,PIN_RESET}_FLOW_ID` and returns `false` when it is unset, so each caller keeps its own "form isn't set up" text.
- `src/whatsapp/whatsapp-transport.module.ts`: `WhatsappService`, `WhatsappMessageService` and `ChunkedMessengerService`, with no domain imports. `MessagingModule` imports only this.

**Routing:**
- A context is present: that channel's adapter. `"app"` throws until P4 adds its adapter.
- No context: WhatsApp (the P5 policy slots in here). If `delivery` is `reply` (the default), `reportMissingContext` logs a warning.
- `WhatsappController.receive` wraps `router.route` in `runInChannel({ channel: "whatsapp" })`.

**Sends labelled outside a context:**
- **Transactional:** `applyTransferResult`, `completeOnboardingAfterFirstTransaction`, `applyBillPaymentResult`, and both credit messages in `RubiesWebhookController`.
- **Proactive:** `AllowanceScheduler.sendNudge` (text and template), `WeeklyReviewService.sendReview`, `ManagerConversationService.sendInitialReply` and `reviewRequest`.

**Migration.** 179 of 184 call sites were mechanical: `this.whatsapp.sendText(X.whatsappNumber, body, X.id)` became `this.messenger.sendText(X, body)`, and the router's `message.fromNumber` + `user.id` became `user`. The rest were edited by hand:
- two Flow sends, which became `requestForm`;
- the template nudge;
- `completeOnboardingAfterFirstTransaction(userId, whatsappNumber)`, which now takes the user.

`PinGateService` and `OnboardingService` no longer inject `ConfigService`.

**Modules.** Onboarding, Manager and Allowance import `MessagingModule` instead of `forwardRef(WhatsappModule)`. Rubies imports both, because it still needs the confirmation services.

**Tests.** Specs construct services with `whatsappTestMessenger({ whatsapp, chunkedMessenger?, config? })` (`src/messaging/testing/`). That is a real messenger and adapter over the spec's existing WhatsApp mocks, so every existing assertion on `whatsapp.sendText("234801", …, "user-1")` still runs unchanged. That is what shows the port changed no output.

**S9** now also forbids `ChannelMessenger` and `MessagingModule` in `orchestrator.module.ts`. **S12** lists the messenger and the adapter.

### P2: identity

**Schema** (migration `20260925150000_user_phone_number`):
- `User.phoneNumber String @unique` is required. It is backfilled with `UPDATE "User" SET "phoneNumber" = "whatsappNumber"`, which is correct because every existing user arrived through WhatsApp, whose sender id is already canonical.
- `User.whatsappNumber` becomes `String?`, still `@unique`.
- New `User.lastAppActiveAt DateTime?`. `lastInboundMessageAt` keeps meaning "a WhatsApp message arrived" (Meta's 24-hour rule) and app activity must never touch it.
- `prisma migrate diff --from-migrations … --to-schema-datamodel …` against a shadow database returns an empty migration.

**Canonical form** (`src/common/phone.util.ts`): international digits with no "+", which is what Meta sends as `from`.
- `normalizePhoneNumber(raw)` handles typed input: `+`, `00`, Nigerian local `0…` or a bare 10-digit number, and a trunk zero after 234. Anything else returns `null`.
- `isNigerianMobile(canonical)` is for the P3 sign-up gate.

**`findOrCreateUser(whatsappNumber)`**, in order:
1. By `whatsappNumber`: update `lastInboundMessageAt`.
2. Otherwise `linkWhatsapp`: `updateMany({ where: { phoneNumber, whatsappNumber: null } })`. This attaches WhatsApp to an app-only account and never overwrites an existing link.
3. Otherwise `create({ phoneNumber: whatsappNumber, whatsappNumber })`.
4. On P2002 (a racing webhook or app sign-up), re-read by `whatsappNumber`, then try `linkWhatsapp` again. If both fail, the number belongs to an account linked to a different WhatsApp number; throw.

**Also changed:**
- `WhatsappChannelAdapter` drops (logged) any send to a user with no `whatsappNumber`. `requestForm` returns `false`.
- Rubies `provisionAccount` receives `phoneNumber`.
- The settings CLI shows `phoneNumber`.

Before P3 no user lacks a WhatsApp number, so the linking path cannot run in production yet.

### P3: authentication

**Layout:**
- `src/app-auth/` (`AppAuthModule`, always loaded): `SmsService` (Termii `/api/sms/send`, `channel: "dnd"`, `SMS_DRY_RUN`), `OtpService`, `SessionService`, `LoginService`, `LoginApprovalService`, `secret-hash.util.ts`, `AppAuthConfig`.
- `src/app-api/` (`AppApiModule`, imported by `AppModule` only when `APP_API_ENABLED=true`): `AppAuthGuard` as `APP_GUARD`, `@Public()`, `@CurrentPrincipal()`, `AuthController`, `MeController`.
- `WhatsappModule` imports `AppAuthModule` so the router can answer `login_approve:` / `login_deny:` buttons; those are matched before the pre-account onboarding branch.

**Data** (migration `20260925170000_app_sign_in`): `AuthOtp` (`codeHmac`, `attempts`, `requestIp`, `expiresAt`, `consumedAt`), `Device` (`platform`, `name`, `pushToken`, `trustedAt`, `lastSeenAt`, `revokedAt`), `AppSession` (`familyId`, `accessHash`, `refreshHash`, expiries, `rotatedAt`, `revokedAt`), `LoginChallenge` (`method` PIN or WHATSAPP, `tokenHash`, `approvedAt`, `rejectedAt`, `consumedAt`, `expiresAt`). New `EmailType.NEW_DEVICE_LOGIN`.

**Codes:** 6 digits from `randomInt`; stored as `HMAC-SHA256(OTP_PEPPER, "phone:code")`. 10-minute expiry, 5 attempts claimed atomically before comparing, a 60-second resend gap, 5 per number and 20 per address per hour, and `SMS_DAILY_CAP` per rolling day (Sentry alert on hit). Each new code consumes the previous open one.

**Tokens:** `udr_at_` / `udr_rt_` / `udr_lc_` prefixes plus 32 random bytes (base64url), stored as SHA-256. Access 15 minutes, refresh 30 days (env). Refresh claims `rotatedAt` atomically and issues a successor in the same family. A rotated token presented again after 30 seconds revokes the family; within 30 seconds it returns 409 (client race).

**Sign-in (`LoginService.signIn`):** verify code, then find or create the `User` by `phoneNumber` (created only now; P2002 re-read), then create a `Device`. Step-up: `pinHash` gives PIN; else `whatsappNumber` gives a WhatsApp buttons message; else none. On success the device is trusted, the other channels are warned (WhatsApp text after a PIN step-up; email for any existing user), and tokens are issued.

**Routes:**

| Route | Auth | Result |
| --- | --- | --- |
| `POST /v1/auth/otp` | public, 10/min | 202 `{expiresAt, resendAfter}`; 400 not a Nigerian mobile; 429 `too_soon` or `rate_limited`; 503 `unavailable` |
| `POST /v1/auth/verify` | public, 10/min | 200 `authenticated` with tokens, or `step_up_required` with `{method, challengeToken, expiresAt}`; 401 `invalid_code` (+`attemptsLeft`), `expired`, `exhausted` |
| `POST /v1/auth/step-up/pin` | public, 10/min | 200 tokens; 401 `wrong_pin` or `invalid_challenge`; 423 `pin_locked`; 410 `expired` |
| `POST /v1/auth/step-up/whatsapp` | public | 202 `pending`; 200 tokens; 403 `denied`; 410 `expired` |
| `POST /v1/auth/refresh` | public | 200 tokens; 409 `refresh_in_progress`; 401 `invalid_refresh_token` |
| `POST /v1/auth/logout` | session | 204, revokes the session family |
| `GET /v1/me` | session | `{id, phoneNumber, name, onboardingStage, hasPin, whatsappLinked, hasEmail}` |

**Also changed:** `AllExceptionsFilter` passes deliberate `HttpException` bodies through (the app needs `attemptsLeft` and the like) and still reduces unexpected errors to a generic 500. `main.ts` sets `trust proxy` to 1. `AppThrottlerGuard` replaces `ThrottlerGuard`, keying on a token digest when a bearer token is present.

**New-device cap:** decided (24 hours, default ₦20,000), not enforced yet. It runs from `Device.trustedAt` and lands with the first app-originated transfers (P4, P7).

## Invariants

Code must still enforce:

- **S7:** money moves only after PIN verification. P0 does not change the `PENDING_PIN` gate.
- Every money-state transition is an atomic claim. Bill cancel now is too.
- A confirm or cancel only ever acts on the caller's own row.
- A KYC submission reaches `provisionAccount` at most once per form sent.
- The KYC values and the PIN travel only in the in-memory `sensitive` map (S5, S6 unchanged).

## Tests

- **Unit:**
  - P0: `npx jest src/whatsapp/bill-payment-confirmation src/whatsapp/transfer-confirmation src/whatsapp/whatsapp-router src/whatsapp/pin-outcome src/onboarding`
  - P1: `npx jest src/messaging`
  - P2: `npx jest src/common/phone src/whatsapp/whatsapp-router src/messaging src/onboarding`
  - P3: `npx jest src/app-auth src/app-api src/common src/config src/whatsapp/whatsapp-router`
  - then the full `npm test`
- **Golden:** unchanged. P0 does not touch the orchestrator.
- **E2e:** `npm run e2e` with the dry-run flags. From P3, `e2e/scenarios/app/` needs the server on `APP_API_ENABLED=true SMS_DRY_RUN=true` with `OTP_PEPPER` shared with the runner (see DEVELOPMENT.md).

## Rollout / risk

- The migration only adds a nullable column and is safe on a live table.
- A user holding an open KYC form at deploy time gets one "expired" message and a new form.
- Bill re-quote is a visible change on WhatsApp. It is covered in the spec.

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-25 | Initial: overall approach; P0 in detail |
| 2026-09-25 | P1: messenger port as built |
| 2026-09-25 | P2: identity as built |
| 2026-09-25 | P3: authentication as built |
