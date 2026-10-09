# ADR-0002: The mobile app as a second channel, with SMS login

- **Status:** accepted
- **Date:** 2026-09-25
- **Deciders:** Egwu David Samuel

## Context

Udara is being built as a standalone iOS/Android app as well as a WhatsApp agent. Three facts shape how:

1. **WhatsApp has been Udara's identity layer.** A person is a phone number that Meta vouched for in a signed webhook. There is no login, session or device model. An app needs all three.
2. **Several security rules are written for WhatsApp specifically.** AGENTS.md says "KYC and PIN only via WhatsApp Flows". S2, S5, S6 and S13 describe WhatsApp payloads. An app changes where these secrets arrive from, which `SECURITY.md` §4.7 says needs a recorded human decision.
3. **Button payloads were trusted.** Confirm and cancel looked a transaction up by id alone. That was safe only because WhatsApp is the only client and Meta signs every tap. The app can send any id it likes.

## Decision

**One account, two channels.**
- The app is a second channel into the same engine, not a separate product.
- A phone number is one `User` on both channels, sharing balance, limits, conversation memory and the managers' gate.
- The rules that protect the money (window, allowance, fees, confirm then PIN, seven-day settings wait) live in services, and both channels go through them. The app gets no route around them.

**KYC and PIN may be entered on native app screens,** which replaces "only via WhatsApp Flows" when P4 lands. They go to dedicated form endpoints, never the chat. Values are handed to the existing handlers in the same in-memory `sensitive` map the WhatsApp path uses. They are never stored in a message row and never logged. AGENTS.md is amended in the same change as those endpoints.

**The API ships switched off.** `/v1` exists only when `APP_API_ENABLED=true`, and only then does boot require its secrets, so deploying the code changes nothing until someone chooses to turn it on.

**Login is by SMS one-time code.**
- 6-digit codes, stored only as an HMAC with a server-side pepper.
- A 10-minute expiry, 5 attempts, per-phone and per-IP send caps, and a global daily SMS cap.
- The `User` row is created only after a code verifies.
- Sessions use opaque random tokens stored as hashes: a 15-minute access token and a rotating refresh token that revokes its family if reused. No JWT library.

**New-device step-up**, because a SIM swap or a recycled number gives an attacker the SMS code:
- The user has a PIN: the code **and** the PIN. This shares the existing PIN lockout. An attacker could lock a real user out for a while; that is accepted as better than letting them in.
- No PIN yet, WhatsApp linked: the code plus an "is this you?" confirmation on WhatsApp.
- No PIN, app only: a PIN must be set straight after KYC, before funding instructions are shown.
- Every new device is announced on the user's other channels and by email.

**Every lookup that takes an id from the client is scoped to the caller.** This started in P0 with confirm and cancel, for both channels.

**New invariants, enforced by `scripts/check-security.js` as they land:**
- **S14:** `/v1` routes need authentication unless marked `@Public()` in an allow-listed file.
- **S15:** app controllers never log or serialize a body, take DTO classes rather than `unknown`, and keep secrets and phone numbers out of query strings. Sentry does not strip `query_string`.
- **S16:** codes and tokens are stored only as hashes.
- **S17:** money executes only from `PinOutcomeService`, and native money endpoints require an idempotency key.

## Alternatives considered

- **A separate app-only account system.** Simpler to build. Rejected because one person could then hold two accounts with two sets of limits, which defeats a discipline product.
- **JWTs.** Rejected. Every request needs the database anyway (user, device, lockout state), so a signed token saves nothing. It would bring key management and make revocation harder.
- **A WhatsApp authentication template as the only code channel.** Rejected because it keeps a WhatsApp dependency for people choosing the app to avoid WhatsApp. It stays as a fallback for numbers already linked to WhatsApp, which also helps with Nigeria's DND SMS blocking.
- **Letting biometrics replace the transfer PIN.** Rejected for v1. It would change S7. Biometrics may unlock the app only.

## Consequences

- Most of the work is backend: a messenger port, auth, and structured money decisions. See the initiative plan.
- The SMS provider becomes a cost and abuse surface that needs a cap and an alert.
- Cross-channel state (a wizard open on one channel while the user types on the other) needs explicit handling in P4.
- Settled 2026-09-25 (Egwu David Samuel): transfers from a newly trusted device are capped for its first 24 hours (default ₦20,000, configurable). Enforced where app-originated transfers exist (P4, P7).
- Settled 2026-10-09 in [ADR-0003](0003-account-closure-and-retention.md): the account deletion and retention policy (P9).

## Follow-up

- Initiative: [`initiatives/mobile-app/plan.md`](../../initiatives/mobile-app/plan.md)
- Spec: [`docs/specs/MOBILE_APP_SPEC.md`](../specs/MOBILE_APP_SPEC.md)
- Tech design: [`docs/tech-design/MOBILE_APP_TECH.md`](../tech-design/MOBILE_APP_TECH.md)
