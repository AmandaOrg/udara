# Beneficiary prefill — tech design

- Spec: [../specs/BENEFICIARY_PREFILL_SPEC.md](../specs/BENEFICIARY_PREFILL_SPEC.md)
- Plan: [../../initiatives/beneficiary-prefill/plan.md](../../initiatives/beneficiary-prefill/plan.md)

## Approach

Extend existing `Recipient` model — no parallel beneficiary table. Orchestrator may propose `beneficiary_name`; [`TaggingService`](../../src/tagging/tagging.service.ts) resolves via [`beneficiary-match.util.ts`](../../src/tagging/beneficiary-match.util.ts).

[`AccountActionsService.startTransferWizard`](../../src/whatsapp/account-actions.service.ts) calls `resolveBeneficiaryHints` before `advanceWithHints`. Ambiguous matches store `contextData.beneficiaryPick` on `ConversationSession` and send a WhatsApp list (`beneficiary:{recipientId}`).

## Data

Migration adds `Recipient.nickname`, `Recipient.lastUsedAt`. `TransferWizardHints.beneficiaryName` is sanitized in orchestrator (not a NUBAN parser).

## Invariants

- Confirm → PIN → execute unchanged
- Model never receives invented account numbers for nicknames in user-visible copy
- `Recipient.label` not overwritten on repeat sends; spend purpose uses `Transaction.purposeLabel`

## Tests

- `beneficiary-match.util.spec.ts`
- `account-actions.service.spec.ts` (prefill + disambiguation)
- Golden `beneficiary_unique_prefill_wizard`

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-28 | Initial |
