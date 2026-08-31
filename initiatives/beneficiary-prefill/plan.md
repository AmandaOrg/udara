# Initiative: beneficiary prefill

Companion spec: [docs/specs/BENEFICIARY_PREFILL_SPEC.md](../../docs/specs/BENEFICIARY_PREFILL_SPEC.md)  
Companion tech design: [docs/tech-design/BENEFICIARY_PREFILL_TECH.md](../../docs/tech-design/BENEFICIARY_PREFILL_TECH.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

Users re-enter account and bank for people they have sent to before. Product wants “send to james” to prefill, not auto-send.

## Evidence

- `Recipient` model keyed by `(userId, accountNumber, bankCode)` only — no nickname lookup
- Repeat sends always walk the full wizard account/bank steps

## Scope

- `Recipient.nickname` + `lastUsedAt`
- Orchestrator `beneficiary_name` hint + live facts nicknames
- Unique match → prefill; ambiguous → list; confirm/PIN unchanged

## Non-goals

- Skipping confirm or PIN
- Regex NUBAN extraction from free text

## Phase 1 — Prefill

**Status:** completed  
**Started:** 2026-08-28  
**Completed:** 2026-08-28  
**Owner:** engineering

### Deliverables

- [x] Spec + tech registered
- [x] Recipient fields + migration
- [x] Match + disambiguation in AccountActions
- [x] Router handler for `beneficiary:` list replies
- [x] Tests + golden

### Progress log

- 2026-08-28: Shipped beneficiary prefill on `Recipient` + orchestrator hint.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Prefill | completed |
