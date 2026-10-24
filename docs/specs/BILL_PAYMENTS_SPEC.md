# Bill payments

**Status:** Phase A + B shipped in code (2026-08-30)  
Initiative: [initiatives/bill-payments/plan.md](../../initiatives/bill-payments/plan.md)  
Tech design: [../tech-design/BILL_PAYMENTS_TECH.md](../tech-design/BILL_PAYMENTS_TECH.md) (full implementation) · [SPIKE](../tech-design/BILL_PAYMENTS_SPIKE.md) (API discovery)

## Problem

Users want airtime, mobile data, and prepaid electricity from Amanda without leaving WhatsApp.

## Goals

- One-off airtime, data bundles, and prepaid electricity via Rubies BaaS VAS
- Same money path as transfers: wizard → confirm → PIN → execute
- Surfaces own all amounts; orchestrator may launch wizards **and** pass sanitized hints (never product codes for data)

## Non-goals

- Cable TV, transport tolls, recurring bills
- Skipping PIN or confirm

## User-visible behavior

### Airtime

Menu **Buy airtime** or chat intent → pick network → enter amount → enter phone → confirm card → PIN → Rubies purchase.

### Data

Menu **Buy data** or chat intent → pick network → pick bundle (fixed price) → enter phone → confirm → PIN → execute.

### Prepaid electricity

Menu **Pay electricity** or chat intent → pick DisCo → enter meter → Rubies verifies customer name → enter amount → confirm shows verified name → PIN → execute. Success message includes token when Rubies returns one.

All categories respect spending window, allowance evaluation, and fee rules like transfers.

## Acceptance

- Prisma models persist draft + payment state including `vendorToken` for electricity
- `RubiesService.purchaseVas`, `validateVasCustomer`, `queryVasTransaction`
- WhatsApp router handles list buttons and typed wizard steps deterministically
- Webhook resolves pending VAS payments by `idempotencyKey`

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-31 | Chat prefill + spend-check via [AI_MONEY_INTENTS_SPEC.md](AI_MONEY_INTENTS_SPEC.md) |
| 2026-08-30 | Phase A airtime + Phase B data/electricity spec |
| 2026-08-28 | Initial spike spec |
