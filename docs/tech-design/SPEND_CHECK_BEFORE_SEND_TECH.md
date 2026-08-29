# Spend check before send — tech design

- Spec: [../specs/SPEND_CHECK_BEFORE_SEND_SPEC.md](../specs/SPEND_CHECK_BEFORE_SEND_SPEC.md)
- Plan: [../../initiatives/spend-check-before-send/plan.md](../../initiatives/spend-check-before-send/plan.md)

## Approach

Keep `propose_turn`. Put the pause in TypeScript so the model cannot skip it by proposing `transfer_wizard` with leftover hints. Store pending send hints on `ConversationSession.contextData` so the second turn can still launch.

Does not change Rubies, PIN Flows, fee math, or wizard steps.

## Data / types

No migration. `ConversationSession.contextData` JSON:

```ts
{ spendCheck: TransferWizardHints | null }
```

Helpers on [`src/orchestrator/transfer-hints.util.ts`](../../src/orchestrator/transfer-hints.util.ts):

- `hasStatedSpendPurpose(text)` — proceed-after-check heuristic (not a transfer parser; not a first-turn skip)
- `shouldPauseForSpendCheck(text)` — true for any first active send utterance
- `isSpendCheckProceedUtterance(text)` / `isSpendCheckAbortUtterance(text)`

## Control flow

1. Load session `spendCheck` hints.
2. Live facts: if pending, `Active mode: spend_check` plus stored hints.
3. `ActionValidatorService.validate(..., userText, { spendCheckPending })`:
   - Closed or abort → no wizard.
   - `shouldPauseForSpendCheck` (any first active send) and not pending → no promote; `show_surface transfer_wizard` becomes `reply_only`.
   - Pending + proceed / still sending / high-confidence wizard → may launch.
4. Orchestrator: on a paused first send, persist sanitized hints and replace a lead-in (“on it.”) with a fixed challenge if the model did not actually ask.
5. On launch or abort, clear `spendCheck`.

## Invariants

- Surfaces still own balances; challenge copy must not invent ₦ figures.
- Confirm then PIN still required after the wizard.
- Closed-send utterances still cannot relaunch the wizard.
- Purpose heuristics are skip-check only; they do not extract account numbers.

## Tests

- Unit: `transfer-hints.util.spec.ts`, `action-validator.service.spec.ts`, `orchestrator.service.spec.ts`
- Golden: first send (vague or purpose) → `expected_surface` null; proceed-after-check wizard
- Commands: `npx jest src/orchestrator` and `npm run orchestrator:golden`

## Rollout / risk

Purpose keyword list is English/Nigerian-English and incomplete on purpose. Prefer false pause (one extra question) over skipping the check.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-27 | Initial |
| 2026-08-29 | Purpose/label no longer skip the first-send pause |
| 2026-08-29 | First-send pause includes purpose-stated sends |
