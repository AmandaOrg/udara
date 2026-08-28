# Bill payments (spike)

**Status:** Blocked pending Rubies API confirmation  
Initiative: [initiatives/bill-payments/plan.md](../../initiatives/bill-payments/plan.md)  
Tech design: [../tech-design/BILL_PAYMENTS_SPIKE.md](../tech-design/BILL_PAYMENTS_SPIKE.md)

## Problem

Users may want airtime and utility bills from Udara. Vending APIs are not confirmed on the BaaS wallet path this app uses.

## Goals

- Document BaaS vs Open API findings
- Unblock Phase A (one-off airtime) only after debit path is confirmed

## Non-goals

- Building `BillPaymentDraft` before confirmation
- Recurring bills in this spec

## User-visible behavior (when unblocked)

Same as transfers: deterministic wizard → confirm → PIN → Rubies execute. Surfaces own numbers.

## Acceptance

- Spike doc lists API paths and blocker status
- No production bill-pay code until Rubies confirms wallet debit

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-28 | Initial spike spec |
