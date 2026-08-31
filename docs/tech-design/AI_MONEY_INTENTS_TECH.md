# AI money intents — tech design

- Spec: [../specs/AI_MONEY_INTENTS_SPEC.md](../specs/AI_MONEY_INTENTS_SPEC.md)
- Plan: [../../initiatives/ai-money-intents/plan.md](../../initiatives/ai-money-intents/plan.md)

## Approach

Keep money movement on existing wizards. Extend orchestrator hints + validator so chat can **launch and prefill**, never execute. Map telco/DisCo strings in WhatsApp catalog code. Parse naira in `src/common/naira-amount.util.ts`.

Does not change PIN, HMAC, or Rubies execute paths.

## Data / types

- `TransferDraftStep.AWAITING_PURPOSE_NOTE`
- `TransferDraft.purposeNote`, `Transaction.purposeNote` (optional string, max 200)
- `TransferWizardHints` also carries bill fields: `msisdn`, `telcoHint`, `meter`, `discoHint`, `purposeNote`, `pendingSurface`
- `propose_turn.extracted_hints`: `msisdn`, `telco_hint`, `meter`, `disco_hint`, `purpose_note`

## Control flow

1. Free text → `propose_turn` → sanitize hints (transfer + bill) → validator
2. First money-out utterance (bank send **or** bill) → `reply_only` spend-check; persist hints + `pendingSurface`
3. Proceed → `show_surface` for that surface with hints
4. Bill surfaces: `BillPaymentActionsService` skip-steps from mapped catalog entries
5. `fill_wizard`: bill draft if active, else transfer draft
6. Other label → ask purpose note → confirm → PIN

Bill vs transfer: `inferBillSurfaceFromText` wins over `pay` in `isActiveSendUtterance`.

## Invariants

- Confirm then PIN
- Model never invents NUBAN/meter/biller codes; catalogs map or the list is shown
- `productCode` for data is list-only
- Surfaces own amounts at execute time

## Tests

- Unit: `naira-amount.util.spec.ts`, `bill-hints.util.spec.ts`, `transfer-hints.util.spec.ts`, `action-validator.service.spec.ts`, `action-executor.service.spec.ts`, `account-actions.service.spec.ts`, `bill-payment-actions.service.spec.ts`
- Golden: `buy_airtime_*`, `pay_nepa_not_transfer`, `beneficiary_unknown_name`, linguistic amount fill
- E2e: not required unless button prefixes change

## Rollout / risk

Wrong `pay` classification is the main risk; goldens cover electricity vs transfer. Weak spend-check copy still replaced by fallback.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-31 | Initial |
