# Initiative: bill payments

Companion spec: [docs/specs/BILL_PAYMENTS_SPEC.md](../../docs/specs/BILL_PAYMENTS_SPEC.md)  
Companion tech design: [docs/tech-design/BILL_PAYMENTS_TECH.md](../../docs/tech-design/BILL_PAYMENTS_TECH.md) · [SPIKE](../../docs/tech-design/BILL_PAYMENTS_SPIKE.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

Users may want airtime, data, and utility bills from the same WhatsApp agent.

## Evidence

- [`RubiesService`](../../src/rubies/rubies.service.ts) — wallet + fund-transfer + **baas-vas purchase/query/validate**
- Live prod smoke: `scripts/rubies-vas-*.mjs`
- Spike write-up: [BILL_PAYMENTS_SPIKE.md](../../docs/tech-design/BILL_PAYMENTS_SPIKE.md)

## Scope

- Phase A: one-off airtime (`BillPaymentDraft`, confirm → PIN → Rubies)
- Phase B: data bundles + prepaid electricity (meter verify via `customerEnquiry`)
- Phase C: recurring (separate initiative)

## Non-goals

- Recurring scheduler in the first ship
- Skipping PIN for bill pay
- Open API (`openapi.rubiesbank.io`) client

## Phase 0 — API spike

**Status:** completed  
**Completed:** 2026-08-30

## Phase 1 — One-off airtime

**Status:** completed  
**Completed:** 2026-08-30

### Deliverables

- [x] Prisma `BillPaymentDraft` / `BillPayment` models + migration
- [x] `RubiesService.purchaseVas` / `queryVasTransaction`
- [x] WhatsApp wizard + confirm/PIN/execute services
- [x] Router, orchestrator surface, webhook wiring
- [x] Targeted tests + golden/orchestrator check

## Phase 2 — Data + electricity

**Status:** completed  
**Started:** 2026-08-30  
**Completed:** 2026-08-30

### Deliverables

- [x] Schema: `DATA`, `ELECTRICITY` categories; `productLabel`, `customerName`, `vendorToken`
- [x] Curated catalogs in `bill-payment-catalog.ts`
- [x] `RubiesService.validateVasCustomer` (`POST /baas-vas/customerEnquiry`)
- [x] Data + electricity wizards, menu items, orchestrator surfaces
- [x] Category-aware confirm/success copy; electricity token on success
- [x] Spec + spike docs updated

### Progress log

- 2026-08-30: Live catalog probe; data bundles + 9 DisCos locked; full wiring landed.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 0 | API spike | completed |
| 1 | One-off airtime | completed |
| 2 | Data + electricity | completed |
| 3 | Recurring | not started |
