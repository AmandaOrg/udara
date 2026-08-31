# Initiative: AI money intents

Companion spec: [docs/specs/AI_MONEY_INTENTS_SPEC.md](../../docs/specs/AI_MONEY_INTENTS_SPEC.md)  
Companion tech design: [docs/tech-design/AI_MONEY_INTENTS_TECH.md](../../docs/tech-design/AI_MONEY_INTENTS_TECH.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

Bill/airtime wizards and beneficiary prefill exist as deterministic WhatsApp flows, but chat does not prefill them. The model’s bill hints are dropped, `fill_wizard` only updates transfers, “pay electricity” can look like a bank send, Other is an enum tap with no typed purpose, and amount prompts demand digits only.

## Evidence

- [`action-validator.service.ts`](../../src/orchestrator/action-validator.service.ts) keeps `extractedHints` only for `transfer_wizard`
- [`action-executor.service.ts`](../../src/orchestrator/action-executor.service.ts) launches bill wizards with no hints
- [`isActiveSendUtterance`](../../src/orchestrator/transfer-hints.util.ts) matches `pay`
- Transfer copy: “just the number, e.g. 5000”

## Scope

- Sanitize and apply bill hints (amount, phone, telco, meter, DisCo) in code
- Spend-check pause for bill intents; never promote them onto `transfer_wizard`
- Proactive beneficiary pick from saved rows only
- Free-text purpose after Other (`purposeNote`)
- Shared naira parser and natural amount copy

## Non-goals

- LLM-chosen data `productCode`
- Inventing NUBANs, meters, or billers
- Skipping confirm or PIN

## Phase 1 — Chat wiring

**Status:** in progress  
**Started:** 2026-08-31  
**Owner:** engineering

### Deliverables

- [x] Spec + tech registered
- [x] Bill hints, validator, executor, wizard skip-steps
- [x] Beneficiary list when send has no payee
- [x] Other → typed purpose
- [x] Linguistic amounts + goldens

### Progress log

- 2026-08-31: Initiative opened with the implementation PR.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Chat wiring for bills, beneficiaries, Other, amounts | in progress |
