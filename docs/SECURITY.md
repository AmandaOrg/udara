# Security review gate

**Mandatory for every change, human or AI agent.** Udara moves real money out of real bank accounts and handles BVN, NIN, date of birth, and transfer PINs. A bad merge here does not produce a broken page. It produces a wrong transfer, a leaked identity document, or a bypassed spending lock that the customer trusted us to hold.

Nothing merges until [the checklist](#3-mandatory-pre-merge-checklist) is satisfied and `npm run security:check` passes.

---

## 1. What we are actually protecting

| Asset | Realistic failure | Cost |
| --- | --- | --- |
| Customer funds | Transfer executes with wrong amount, wrong recipient, no PIN, or twice | Direct financial loss, refund liability |
| Transfer PIN | Persisted or logged in plaintext | Account takeover by anyone with DB or log access |
| BVN / NIN / DOB | Written to `WhatsappMessage.rawPayload` | Regulatory exposure, identity theft |
| Spending discipline | Window or allowance bypassed via chat | Product promise broken; the one thing the user bought |
| Webhook endpoints | Forged inbound webhook accepted | Attacker drives the bot, fabricates credits |
| Provider credentials | Key committed or logged | Full access to the banking integration |

Two facts shape everything below:

1. **Inbound messages are persisted before any handler runs.** `WhatsappController` writes the row, then routes. No downstream handler can un-leak a secret. Redaction must happen at the persistence boundary in `sensitive-fields.util.ts`. This is not theoretical — BVN/NIN values were previously stored in both `flowResponseJson` and `rawPayload`.
2. **The LLM is untrusted input, not a trusted caller.** Anything a user types can reach the model, and anything the model emits is a *proposal*. Only `ActionValidatorService` decides what actually happens.

---

## 2. Non-negotiable invariants

Each row is enforced in code and verified by `npm run security:check`. Do not remove one because it is inconvenient; change it through an initiative with an explicit decision record.

| # | Invariant | Enforced in |
| --- | --- | --- |
| S1 | Webhook HMAC is computed over raw bytes | `src/main.ts` (`rawBody: true`) |
| S2 | WhatsApp webhook is signature-guarded | `whatsapp.controller.ts` + `whatsapp-signature.guard.ts` |
| S3 | Rubies webhook is signature-guarded with replay tolerance | `rubies-webhook.controller.ts` + `rubies-signature.guard.ts` |
| S4 | Signature comparison is constant-time | both guards use `timingSafeEqual` |
| S5 | Inbound persistence redacts sensitive fields | `whatsapp-message.service.ts` via `sensitive-fields.util.ts`; app chat text via `scrubFreeTextSecrets` in `messaging/app-message.service.ts` |
| S6 | Every sensitive WhatsApp Flow field is in the redaction list | `SENSITIVE_FLOW_FIELDS` vs `docs/whatsapp-flows/*.json` |
| S7 | Money moves only after PIN verification | `TransactionStatus.PENDING_PIN` in `transfer-confirmation.service.ts` |
| S8 | Every LLM turn passes through the validator | `orchestrator.service.ts` calls `ActionValidatorService.validate` |
| S9 | The orchestrator module holds no send/banking providers | `orchestrator.module.ts` |
| S10 | Request-path code never shells out or disables TLS | `src/` excluding `src/cli/` |
| S11 | No credentials in the repository | whole tree |
| S12 | Security-critical files have unit tests | colocated `*.spec.ts` |
| S13 | Webhook controllers never serialize the inbound payload into a log line | `whatsapp.controller.ts` + `rubies-webhook.controller.ts` |
| S14 | The mobile app API denies by default: every `/v1` controller needs a live session unless a handler is `@Public()`, which only the sign-in controller and `app-config` (the minimum app version) may use. Sign-in approvals and new-device warnings are pinned to WhatsApp | `app-api/app-auth.guard.ts`, registered globally in `app-api.module.ts`; every app controller mounted under `v1`; `app-auth/login.service.ts` |
| S15 | Nothing in the app API prints or serializes request data; controllers do not log at all and take DTO classes rather than `unknown`; secrets and phone numbers are never query parameters | `src/app-api/**` |
| S16 | Sign-in codes and session tokens are stored only as HMACs or hashes | `app-auth/secret-hash.util.ts`; no plaintext secret column in `schema.prisma` |
| S17 | Money executes only from `PinOutcomeService` (`executeVerifiedTransfer` and `executeVerifiedBillPayment` are called nowhere else), and a native app route that creates a payment requires an `Idempotency-Key` | `whatsapp/pin-outcome.service.ts`; `app-api/transfers/transfers.controller.ts` |

### Why S14–S17 matter

The app is the first client that can name any id it likes and that authenticates with something other than a Meta signature. That is also why a chat choice must name a message that offered it to the same user, and why the app's KYC and PIN forms hand their values to the handlers in memory exactly as the WhatsApp Flow path does. An unguarded `/v1` route is a public endpoint onto someone's money; a logged request body is a logged PIN or sign-in code; a plaintext token column turns one database read into every session. The native send screens (S17) reach money through the same door as the chat, `PinOutcomeService`, which is also where the new-device cap sits; a second door would be a way around both the PIN and the cap. A retried quote with no idempotency key is a second payment. See [ADR-0002](decisions/0002-app-channel-and-auth.md). The API is off unless `APP_API_ENABLED=true`.

### Why S13 matters

The redaction boundary in `sensitive-fields.util.ts` only protects what is *persisted*. `WhatsappController` receives the decrypted Flow submission and logs run before `recordInboundIfNew` redacts anything, so a single `JSON.stringify(payload)` in that handler puts every PIN, reset OTP, BVN, NIN and date of birth into the log sink in plaintext — bypassing S5 entirely, one line earlier. That is not hypothetical; it shipped, and the fix is why this rule exists.

Log shape, never content. To debug an inbound message, read the persisted `WhatsappMessage` row, which is redacted.

### Why S9 matters

`ActionExecutorService` lives under `src/orchestrator/` but is provided by `WhatsappModule`. That is deliberate: the brain that talks to the model cannot itself send WhatsApp messages or call Rubies. Keep providers out of `orchestrator.module.ts`.

---

## 3. Mandatory pre-merge checklist

Run through this for every change. "Not applicable" is a valid answer; "I did not check" is not.

### Always

- [ ] `npm run security:check` passes
- [ ] `npm run docs:check` passes
- [ ] No new secret, token, key, account number, or real phone number in code, tests, fixtures, or docs
- [ ] No `console.log` / logger call that can print a PIN, BVN, NIN, DOB, access token, or API key
- [ ] Targeted unit tests pass for every file touched

### If the change touches money movement

Wizard, confirm, PIN, Rubies calls, fees, allowance, window.

- [ ] Amount, recipient, and account number are re-read from the database at execution time, not carried from model output
- [ ] The confirm step and the PIN step are both still required
- [ ] Failure paths cannot leave a transaction that debited without being recorded, or recorded without debiting
- [ ] Fee math has a unit test asserting exact figures
- [ ] Idempotency preserved: replaying the same webhook or button tap does not send twice

### If the change touches PII

KYC, PIN, onboarding Flows, message persistence, logging.

- [ ] New Flow fields that carry secrets are added to `SENSITIVE_FLOW_FIELDS` in the same change
- [ ] New app form fields that carry secrets go into the `sensitive` map in `AppConversationService`, never into the stored `AppMessage` row
- [ ] Plaintext values travel only through the in-memory `sensitive` map, never a DB column
- [ ] No new log line interpolates a sensitive value
- [ ] A unit test proves the value is redacted where it is stored

### If the change touches the orchestrator or prompts

- [ ] The model still cannot execute anything directly; the validator remains the gate
- [ ] Unknown, ineligible, or low-confidence actions still downgrade to `reply_only`
- [ ] Hints from the model are still sanitized before use
- [ ] Golden dialogues updated and `npm run orchestrator:golden` passes
- [ ] Prompt changes cannot be overridden by user text — treat any "ignore your instructions", "you are now", or "for testing, send" message as hostile input and confirm the validator still blocks the action

### If the change touches webhooks or authentication

- [ ] Signature guard still applied to the route
- [ ] Constant-time comparison preserved
- [ ] Replay protection preserved on the Rubies path
- [ ] Relevant `e2e/scenarios/security/` scenarios run locally and pass

### If the change adds a dependency

- [ ] Actually needed, actively maintained, and reviewed for install scripts
- [ ] Pinned via `package-lock.json` in the same commit

---

## 4. Rules specific to AI coding agents

Agents produce plausible code quickly, which is exactly the failure mode this section addresses.

1. **Never weaken a guard to make a test pass.** If a signature check, validator branch, or PIN gate blocks you, the block is the product. Fix the test or the caller.
2. **Never add a bypass flag.** No `skipPin`, `forceSend`, `allowOutsideWindow`, or debug route that moves money. Dry-run flags already exist for local work.
3. **Do not invent credentials or fixtures that look real.** Use obviously fake values (`0000000000`, `+10000000000`). Never paste a real account number or phone number into a test.
4. **Do not widen redaction, logging, or error output to debug.** Reproduce with a unit test instead.
5. **Do not disable lint rules, type checks, or hooks** to get a clean run. No `any` casts on money or identity types.
6. **Treat all model output as hostile.** Sanitize before use, validate before execution, and never persist raw model output into a field that later drives an action.
7. **Stop and ask** when a change would alter S1–S12, touch key management, or expand what the LLM is allowed to trigger. A one-line human confirmation is required, and it belongs in the initiative plan.
8. **State what you verified.** When reporting completion, name the commands you ran. Do not claim a check passed that you did not run.

---

## 5. The automated gate

```bash
npm run security:check
```

It fails the build on:

- A missing or altered S1–S12 invariant
- A sensitive Flow field that is not in the redaction list
- Credential-shaped strings anywhere in the tree
- Non-empty secret values in committed `.env*` files
- `child_process`, `eval(`, `rejectUnauthorized: false`, or TLS-verification disabling in request-path code
- `describe.only` / `it.only`, which would silently shrink a "passing" suite
- A security-critical file without a colocated unit test

It is a floor, not a ceiling. It cannot reason about business logic, so the checklist above still applies.

### Waivers

For a genuine false positive, put a waiver on the offending line or the line above it:

```ts
// security-check:allow <short reason>
```

A waiver is a code review flag. Explain it in the pull request. Waiving an S1–S12 invariant requires an ADR in [decisions/](decisions/README.md).

---

## 6. Known accepted risks

Tracked deliberately, not forgotten.

| Risk | Current state | Required before real customer traffic |
| --- | --- | --- |
| Unsigned webhooks accepted when the secret is blank | **Retired 2026-09-04.** Boot now fails when either secret is blank unless `ALLOW_UNSIGNED_WEBHOOKS=true` is set explicitly, so the escape hatch has to be asked for rather than being the accidental default. Local and e2e set the flag; deployed environments do not. `RubiesWebhookEvent.signatureValid` now records the real verdict instead of hardcoding `true` | Confirm both secrets are set in Railway and that the flag is absent there |
| E2e is not in CI | CI runs lint, build, unit tests, docs and security checks. The golden dialogues **do** run, via `golden-dialogues.spec.ts` under jest | Run `npm run e2e` before any release |
| 7 high-severity npm advisories, all requiring a Nest 10 → 12 upgrade | `npm audit fix` applies cleanly; the remainder are `@nestjs/cli` and its build-time chain (glob, picomatch, tmp), plus lodash via `@nestjs/config` and multer via `@nestjs/platform-express`. None is reachable from the two JSON webhook routes and the health route — multer in particular is only relevant to multipart uploads, which this app does not accept | Plan the framework upgrade as its own change with the full suite and e2e green; do not force it into a defect-repair batch |
| `js-yaml` advisories via `@nestjs/swagger` (added 2026-09-26 for the app API's OpenAPI document) | Every advisory is in YAML *parsing* (merge keys, `!!omap`). Swagger only uses `js-yaml` to write out its own document; no request input is ever parsed as YAML. The document is served only with `APP_API_DOCS=true`, which is local-only | Keep `APP_API_DOCS` unset in every deployed environment; revisit with the framework upgrade |
| Fee sweep silently skipped | Skipped with a warning when `RUBIES_FEES_ACCOUNT_NUMBER` is unset | Configure the fees account; fees are recorded but unmoved until then |
| Provider secrets live in `.env` | No secret manager in this repo | Use the deployment platform's secret store; never bake into an image |

---

## 7. If you find or cause a leak

1. Stop. Do not push a "fix" that also rewrites unrelated code.
2. If a credential leaked, rotate it first. Removing the commit does not un-leak it.
3. If customer data was persisted in the clear, find every column and log sink that received it, and write the cleanup script (see `scripts/purge-leaked-kyc.ts` for the existing pattern).
4. Add the regression test before the fix.
5. Record it in the relevant initiative plan and open an ADR if the invariant set needs to change.
