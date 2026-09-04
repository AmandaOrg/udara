# Production hardening — tech design

## Links

- Spec: [`docs/specs/PRODUCTION_HARDENING_SPEC.md`](../specs/PRODUCTION_HARDENING_SPEC.md)
- Plan: [`initiatives/production-hardening/plan.md`](../../initiatives/production-hardening/plan.md)
- Findings: [`docs/PRODUCTION_ASSESSMENT.md`](../PRODUCTION_ASSESSMENT.md)

## Approach

Defect repair in place. No new modules except a health controller, a Sentry bootstrap, and a rate-limit helper. The orchestrator's proposal/validator boundary, the wizard step machines, and the PIN flow keep their current shape.

**Does not touch:** the discipline formula, the onboarding stage machine, WhatsApp Flow JSON, fee amounts, or the persona voice.

## The ordering constraint that shapes everything

Two of the fixes convert "wrong answer" into "no answer, retry later". That is an improvement **only if something retries**. So the recovery jobs land before the error-semantics change, and the atomic claims land before both, because they are what make a retry safe to re-apply.

| Order | Change | Why here |
| --- | --- | --- |
| 1 | Atomic status claims | Closes a reachable double-debit. Makes every later double-run safe by construction. |
| 2 | Allowance claim + increment | Independent; closes the lost update while the same specs are open. |
| 3 | Recovery jobs | Builds the net that catches what steps 4 and 5 start dropping. Safe now that re-application is idempotent. |
| 4 | HTTP timeouts, per call | A timed-out VAS purchase is now recoverable rather than orphaned. |
| 5 | Rubies response type guard | Every throw it introduces now has a recovery path. |
| 6 | Fee sweep lease | Needs a migration; lowest user impact. |
| 7 | Re-quote on confirm | Only item that changes the happy path; wants the most review. |

**Hard dependency:** bill-payment reconciliation must exist before `purchaseVas` is allowed to throw. Inverting them trades a wrong "it failed" message for a silently stuck payment and no message at all.

## Control flow changes

### Atomic status claims

Every transition becomes a conditional claim. `PinService.consumeChallenge` is the in-repo precedent.

```ts
const claimed = await this.prisma.transaction.updateMany({
  where: { id: transaction.id, status: TransactionStatus.PENDING_PIN },
  data: { status: TransactionStatus.CONFIRMED, confirmedAt: new Date() },
});
if (claimed.count === 0) return;   // lost the race
```

Sites: `confirmTransfer` (to `PENDING_PIN`, `FAILED`, `CANCELLED`), `executeVerifiedTransfer` (to `CONFIRMED`), `applyTransferResult` (to `EXECUTED`/`FAILED`), `cancelTransfer`, `cancelPendingForUser`, and the four bill-payment mirrors.

**Why the `executeVerifiedTransfer` claim is the single most important line in this initiative.** Multiple valid PIN challenges per transaction are designed in, not exceptional: `confirmTransfer` mints one on every call, `pin-gate.service.ts` mints another on every wrong-PIN retry, and `resumePendingTransferUi` mints another for a `PENDING_PIN` row. Nothing invalidates the earlier ones. `consumeChallenge` is single-use *per token*, so N tokens yield N valid execute outcomes, and two arriving together both pass the status read and both call Rubies with the same key. Only Rubies-side dedup stands between that and a double debit.

`applyTransferResult` claims **only from `CONFIRMED`**, which also blocks a forged or misrouted webhook from jumping a `PENDING_PIN` row to `EXECUTED`. All three callers are verified to pass `CONFIRMED` rows. Because `updateMany` cannot `include` relations, it becomes claim, then refetch, then side effects — and the `count === 0` branch must distinguish "already terminal" (silent) from "unexpected status" (logged loudly), or a genuinely missed webhook becomes invisible.

### Allowance

```ts
await this.prisma.$transaction(async (tx) => {
  const claimed = await tx.transaction.updateMany({
    where: { id: transactionId, appliedToAllowanceAt: null },
    data: { appliedToAllowanceAt: new Date(), dailyAllowanceId: allowance.id },
  });
  if (claimed.count === 0) return tx.dailyAllowance.findUniqueOrThrow({ where: { id: allowance.id } });
  return tx.dailyAllowance.update({
    where: { id: allowance.id },
    data: { amountSpent: { increment: transaction.amount } },   // Decimal, never Number()
  });
});
```

Prisma supports atomic `increment` on `Decimal`, compiling to `SET "amountSpent" = "amountSpent" + $1`. Pass the `Decimal` straight through: `Number()` loses precision on `Decimal(14,2)`.

Rubies calls and WhatsApp sends stay **outside** the transaction — holding the allowance row across a bank round-trip would blow the timeout.

### Rubies responses

A body is a verdict only when it is an object carrying a string `responseCode`; otherwise log and throw.

The shared `mapRubiesResponseCode` **keeps its current contract** — its `undefined`/`null` → `FAILED` behaviour is pinned by a deliberate test, and it is also applied to webhook-supplied input. Add a sibling instead:

```ts
/** A missing code means "we don't know", not "it failed". Use where a wrong
 *  FAILED would strand real money. */
export function mapRubiesResponseCodeStrict(code: string | undefined | null) {
  if (code == null || code === "") return "PENDING" as const;
  return mapRubiesResponseCode(code);
}
```

Used by `initiateTransfer`, `queryTransferStatus`, `purchaseVas`, `queryVasTransaction` only. The webhook controller stays on the plain function.

**Two callers must degrade locally rather than propagate**, because they sit on non-money interactive paths where a throw reaches the controller and the user receives nothing at all: `listBanks` returns `[]` (called unwrapped in five places in the transfer wizard) and `validateVasCustomer` returns a not-ok result. Separately, the unguarded `getBalance` inside `confirmTransfer` gets a `.catch` and a retryable message — today a Rubies blip there produces literal silence with a still-live Confirm button.

### Timeouts

A flat 30s is wrong at both ends. Module-level `HttpModule.register` sets a 30s floor; per-call overrides do the real work.

| Call class | Timeout |
| --- | --- |
| Interactive lookups: name enquiry, balance, bank list, meter lookup | 10s |
| Money movement: fund transfer, VAS purchase | 60s |
| Background: transaction status queries | 20s |

An aborted socket does not cancel the transfer server-side, but the row is already `CONFIRMED` with a persisted idempotency key, so reconciliation covers it. This is the same recovery path a `PENDING` response already takes.

### Fee sweep

The claim must remain **re-claimable**, so it leases rather than latches. New columns `feeSweepAttempts` and `feeSweepLastTryAt`:

```ts
where: {
  id, feeSweptAt: null, feeSweepAttempts: { lt: 5 },
  OR: [{ feeSweepLastTryAt: null }, { feeSweepLastTryAt: { lt: leaseCutoff } }],
}
```

The reference must be **deterministic** (`${idempotencyKey}-fee`, the exact key sent to Rubies), or a status query can never find it. A claim predicate of `feeSweepReference: null` would permanently disable the retry job on its first attempt.

**Product constraint:** the fee debits the user's wallet. A retry firing days later surprise-debits a wallet the user has since spent down. Cap recovery at 24 hours, then write off to an ops alert.

### Confirm-time re-quote

Terms are frozen at proposal time, so a user can sit on Confirm until the window closes and still pay the old fee. On confirm, re-run `evaluateSpend`; if type or fee changed, update the row, re-render the same buttons with the new figures, and stay `PENDING_CONFIRMATION`. Never silently upgrade a fee the user did not see.

**Do not hard-expire old pending rows.** A 10-minute kill would break `resumePendingTransferUi`, whose entire purpose is resuming an old confirm, and `resumeAfterPinSetup`, which runs after a Flow round-trip plus first-time PIN choice. Instead, treat age as a re-quote trigger: nothing executes on terms older than 10 minutes without a fresh tap, and the resume flows keep working.

`cancelPendingForUser` currently matches only `PENDING_CONFIRMATION`; extend it to `PENDING_PIN`, which is the more dangerous stack because it carries a live PIN challenge, and make it a status-predicated `updateMany` so it cannot cancel a row that raced to `CONFIRMED`.

### Recovery jobs

Separate crons, so a Rubies outage cannot block the pure-database repair:

| Job | Cadence | Query |
| --- | --- | --- |
| Transfer status | 1 min | `CONFIRMED`, aged past the cutoff |
| Bill status | 1 min | `CONFIRMED` bills via VAS transaction query |
| Allowance repair | 5 min | `EXECUTED` with `appliedToAllowanceAt` null |
| Fee sweep retry | 15 min | unswept, under the attempt cap, inside 24h |

Every query needs `take`, `orderBy` ascending, **and** an age floor. Without ordering, an unresolvable backlog re-fills the same slots and starves the tail; without an age ceiling, a row stuck for a month burns a slot every minute forever. Pair with a daily "older than 7 days and still unresolved" alert.

Overlap protection is a Postgres advisory lock, not a boolean. Railway does zero-downtime deploys, so old and new instances overlap on **every deploy** even at one replica. The lock is load-shedding, not correctness — correctness comes from the atomic claims, since the webhook races the scheduler regardless.

## Data / types

Additive migrations only. Destructive work is deferred.

- `Transaction`: `feeSweepAttempts Int @default(0)`, `feeSweepLastTryAt DateTime?`, plus `@@index([userId, status, createdAt])` and `@@index([status, confirmedAt])`.
- `WhatsappMessage`: index on `fromNumber`.
- `NudgeLog`: unique on user + type + day bucket.
- `SettingsChangeRequest`, `OnboardingSession`: indexes on their lookup columns.

## Invariants

Code must still enforce, unchanged:

- S7: money moves only after PIN verification. The claims tighten this; they never relax it.
- S8: every LLM turn passes through the validator.
- Surfaces own numbers: no balance or allowance figure is ever quoted from model memory.
- The confirm step and the PIN step both remain required.
- Amount, recipient account and bank code are re-read from the database at execution time.

New in this work:

- A missing or unparseable bank response is never recorded as a failure.
- No money-state transition succeeds without an atomic claim on its expected prior status.
- Webhook signature verification cannot be skipped without an explicit, documented opt-out.

## Tests

- **Unit:** targeted specs per touched file. Prisma mocks in `transfer-confirmation.service.spec.ts`, `bill-payment-confirmation.service.spec.ts` and `allowance.service.spec.ts` are plain object literals and need `updateMany` added; `$transaction` must accept the interactive form (`Array.isArray(arg) ? Promise.all(arg) : arg(prisma)`). Assertions pinned to exact object literals or call counts must be rewritten, including the one asserting `amountSpent: 1_500`, which pins the buggy arithmetic itself.
- **New specs:** `transfer-reconciliation.scheduler.ts` and `rubies-webhook.controller.ts` have none today.
- **Golden:** required for the LLM-safety and settings-request phases.
- **E2e:** webhook, signature and transfer scenarios; needs the new unsigned-webhook opt-out set.

## Rollout / risk

Each phase commits separately so any one can be reverted alone.

- Fail-closed startup breaks any environment missing a webhook secret. Verify Railway before deploying.
- The atomic-claim phase is the largest edit surface; land it alone with the full suite green.
- Deploying during the midnight UTC window collides with the daily-boundary cron.
- Several safety properties currently rest on Rubies deduplicating on reference, which no test verifies. Confirm with the provider.

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-04 | Initial, incorporating the adversarial design review that corrected the response-code mapping, the fee-sweep claim predicate, the pending-row expiry, and the ship order |
