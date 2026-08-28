# Initiative: bill payments

Companion spec: [docs/specs/BILL_PAYMENTS_SPEC.md](../../docs/specs/BILL_PAYMENTS_SPEC.md)  
Companion tech design: [docs/tech-design/BILL_PAYMENTS_SPIKE.md](../../docs/tech-design/BILL_PAYMENTS_SPIKE.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

Users may want airtime, data, and utility bills from the same WhatsApp agent. Rubies bill-pay / vending is **not** confirmed on the BaaS wallet API this app already uses.

## Evidence

- [`RubiesService`](../../src/rubies/rubies.service.ts) — wallet + fund-transfer only
- Public Rubies Open API docs — separate host (`openapi.rubiesbank.io`) for airtime/billers
- Spike write-up: [BILL_PAYMENTS_SPIKE.md](../../docs/tech-design/BILL_PAYMENTS_SPIKE.md)

## Scope

- Phase A: one-off airtime (`BillPaymentDraft`, confirm → PIN → Rubies)
- Phase B: data + Nepa/electricity billers
- Phase C: recurring (separate initiative)

## Non-goals

- Building wizards before API confirmation
- Recurring scheduler in the first ship
- Skipping PIN for bill pay

## Phase 0 — API spike

**Status:** blocked  
**Started:** 2026-08-28  
**Owner:** engineering

### Deliverables

- [x] Spike doc with BaaS vs Open API comparison
- [ ] Live confirmation with Rubies which API debits user wallets
- [ ] Phase A spec/tech update once confirmed

### Progress log

- 2026-08-28: Spike doc written; implementation blocked.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 0 | API spike | blocked |
| 1 | One-off airtime | not started |
| 2 | Data + electricity | not started |
| 3 | Recurring | not started |
