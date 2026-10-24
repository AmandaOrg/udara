# Testing

Verification is part of the product. A change that moves money, routing, or orchestrator actions is not done until the matching layer below is green.

## Layers

| Layer | How | What it proves |
| --- | --- | --- |
| Unit | `npm test` — Jest, `src/**/*.spec.ts` | Pure logic, validators, fee math, router branches |
| Golden dialogues | `npm run orchestrator:golden` and `golden-dialogues.spec.ts` | Validator + fixtures for `propose_turn` outcomes |
| E2e | `npm run e2e` — real HTTP, running server | Webhooks, persistence, wizards, signatures |

Jest `roots` is `src/` only. E2e is **not** a Jest project.

## Unit

```bash
npm test
npx jest src/orchestrator/action-validator.service.spec.ts
```

New services and non-trivial utilities need a spec. Mock Prisma and outbound HTTP. Do not call live Meta/Rubies/LLM in unit tests.

## Golden orchestrator evals

Canonical cases: [`src/orchestrator/evals/golden-dialogues.json`](../src/orchestrator/evals/golden-dialogues.json).

They feed a **mock** `propose_turn` into `ActionValidatorService`. They do not measure live model quality. When you change validator rules, surfaces, or transfer-intent gating, add or update cases in the same PR.

```bash
npm run orchestrator:golden
```

## E2e (black box)

Contract: [e2e/README.md](../e2e/README.md).

- No `TestingModule`. Helpers must not import `src/`.
- Server must run with dry-runs and matching verify token.
- Assert HTTP ack **and** Postgres side effects.

For non-trivial changes, cover where applicable:

1. Happy path (webhook 200 + expected outbound / DB)
2. Signature / auth bypass (unsigned local vs wrong HMAC when secret set)
3. Idempotency (`waMessageId` redelivery → single inbound row)
4. Malformed payloads do not crash the process
5. No raw KYC/PIN in persisted message bodies

CI does not run e2e. Run the relevant subset locally (`npm run e2e:smoke` or a name prefix).

The mobile app scenarios (`e2e/scenarios/app/`, prefix `app.`) need the server started with `APP_API_ENABLED=true SMS_DRY_RUN=true PUSH_DRY_RUN=true OTP_PEPPER=<value>` and the same `OTP_PEPPER` in the runner's environment. See [DEVELOPMENT.md](DEVELOPMENT.md#environment), including the note on overriding a hosted `DATABASE_URL`.

`app.account.compliance` also runs the account-closure ops CLI (`e2e/helpers/ops.ts`) against the e2e database. It uses the build in `dist/` when there is one, the same build the server runs from, so build before running it. It refuses any database that is not on localhost: the CLI loads `.env`, and closing accounts must never reach a real database.

## Matrix for common change types

| Change | Unit | Golden | E2e |
| --- | --- | --- | --- |
| Fee / window / allowance math | Required | — | Optional smoke |
| Router / webhook / HMAC | Required | — | Required relevant scenarios |
| Orchestrator validator / hints | Required | Required | Optional stub failure SOP |
| Inbound voice/image | Required (mocked Meta/Deepgram) | If spend-check gating | Optional |
| Transfer wizard / confirm / PIN | Required | If intent gating | Transfer scenarios |
| App sign-in / sessions / `/v1` guard | Required | — | `app.` scenarios |
| Docs-only | `npm run docs:check` | — | — |

Every change also runs `npm run security:check`. Files listed as security-critical in [`scripts/check-security.js`](../scripts/check-security.js) must keep a colocated spec — that list is what stops a guard from losing its only CI coverage. See [SECURITY.md](SECURITY.md).

## AI providers in tests

Default `AI_PROVIDER=stub` does not emit real `propose_turn` tool calls. Free-text e2e then hits the failure SOP. Deterministic keyword/menu paths are preferred for smoke. Live LLM is opt-in (`E2E_ORCHESTRATOR_LIVE=1`).
