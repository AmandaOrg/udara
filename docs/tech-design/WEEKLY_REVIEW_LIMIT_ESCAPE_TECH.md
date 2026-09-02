# Weekly review limit escape

## Links

- Spec: [../specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md](../specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md)
- Plan: [../../initiatives/weekly-review-limit-escape/plan.md](../../initiatives/weekly-review-limit-escape/plan.md)

## Approach

Change lives in [`src/whatsapp/weekly-review.service.ts`](../../src/whatsapp/weekly-review.service.ts) and [`src/whatsapp/whatsapp-router.service.ts`](../../src/whatsapp/whatsapp-router.service.ts). Orchestrator, validator, transfer/bill wizards, and the 2× ceiling are untouched.

Do **not** leave `AWAITING_LIMIT` open while falling through: the intercept sits above transfer/bill handling, so a later parsed amount would still be stolen as a daily limit.

## Data / types

`WeeklyReview.updatedAt` (`DateTime @updatedAt`) — TTL clock for “last status change” (Adjust tap, or a too-low / too-high retry that stays `AWAITING_LIMIT`). Existing rows backfill from `createdAt`.

Status stays `SENT | AWAITING_LIMIT | COMPLETED`. Abandon / TTL / Keep all use `COMPLETED` with `newDailyLimit` unset.

`AWAITING_LIMIT_TTL_MS` = 24 hours.

## Control flow

Post-onboarding `handleUserUtterance`:

1. `getReviewAwaitingLimit(userId, now)` — if the newest `AWAITING_LIMIT` row’s `updatedAt` is older than 24h, complete it with no override and treat as none.
2. If awaiting and `BILL_CANCEL_WORDS` (`cancel` / `stop` / `nevermind`): `abandonAwaitingLimit({ ack: true })` and return.
3. If awaiting and `parseNairaAmount(text)` is non-null: `handleLimitText` and return (in-range completes; too low / too high stay `AWAITING_LIMIT` and bump `updatedAt`).
4. If awaiting otherwise: `abandonAwaitingLimit({ ack: false })` then continue (menu, wizards, orchestrator).

`sendReview`: `updateMany` any `AWAITING_LIMIT` whose `weekStartDate` is not this recap week to `COMPLETED` before creating the new row, so a unique-constraint retry cannot wipe an in-progress same-week Adjust.

## Invariants

- Model still does not execute transfers or invent balances
- Weekly override still only written from a parsed amount in `handleLimitText`
- Confirm/PIN/HMAC unchanged
- `orchestrator.module.ts` still has no WhatsApp send

## Tests

- Unit: [`src/whatsapp/weekly-review.service.spec.ts`](../../src/whatsapp/weekly-review.service.spec.ts), [`src/whatsapp/whatsapp-router.service.spec.ts`](../../src/whatsapp/whatsapp-router.service.spec.ts)
- Golden: none
- E2e: none

Commands: `npx jest src/whatsapp/weekly-review.service.spec.ts src/whatsapp/whatsapp-router.service.spec.ts`; `npm run security:check`; `npm run docs:check`.

## Rollout / risk

No data backfill. First non-amount inbound after deploy completes leftover `AWAITING_LIMIT`. Same-week Adjust is preserved when the Sunday scheduler re-ticks.

## Changelog

| Date | Change |
| --- | --- |
| 2026-09-02 | Initial |
