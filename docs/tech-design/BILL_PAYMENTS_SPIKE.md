# Bill payments — Rubies API spike

**Status:** Phase A + B shipped (2026-08-30)  
Initiative: [initiatives/bill-payments/plan.md](../../initiatives/bill-payments/plan.md)

## Question

Can Udara vend **one-off airtime** (and later data / Nepa electricity) by debiting the **same Rubies BaaS wallet** users already fund for transfers?

**Answer (confirmed 2026-08-30):** Yes — use **`POST /{stage}/baas-vas/purchase`** on the same `RUBIES_BASE_URL` / `RUBIES_API_KEY` as transfers. Catalog: `GET /{stage}/baas-vas/biller-category`, `biller-list`, `product-list`. Status: `GET /{stage}/baas-vas/transaction-query/{requestReference}`.

## What this codebase uses today

[`RubiesService`](../../src/rubies/rubies.service.ts) targets **RubiesSme BaaS**:

- Host: `RUBIES_BASE_URL` (default `https://api-sme-dev.rubies.ng`)
- Paths: `/{stage}/baas-wallet/*`, `/{stage}/baas-transaction/*`
- Implemented: `create-wallet`, `retrieve-wallet-details`, `name-enquiry`, `balance-enquiry`, `fund-transfer`, `tsq`, `bank-list`, **`purchaseVas`**, **`queryVasTransaction`**

## Public Rubies Open API (different surface)

Rubies also documents a separate **Open API** (`openapi.rubiesbank.io`) with bill/airtime endpoints, for example:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/ctairtimepurchase` | Airtime purchase (`mobilenumber`, `telco`, `amount`, `reference`) |
| `POST /v1/ctairtimequery` | Status query |
| `GET /v1/billercategory` / biller list | Biller catalog |
| `POST /v1/billerverification` | Customer ID verification (electricity) |
| Same purchase path with `billercode` | Biller payment (e.g. prepaid electricity) |

Auth docs describe **sk_test_ / sk_live_** keys on the BAAS dashboard — not the same raw `RUBIES_API_KEY` header shape used by `RubiesService.post()` today.

## Spike result (this repo)

| Check | Result |
| --- | --- |
| BaaS VAS on prod (`api-sme.rubies.ng/prod/baas-vas/*`) with existing API key | **Yes** — live smoke tests (`scripts/rubies-vas-*.mjs`) |
| Airtime debits user wallet (`accountNumber` on purchase body) | **Yes** — ₦200 MTN airtime succeeded (`responseCode 00`) |
| Sync `106` with debit+reversal | **Observed** — treat PENDING + webhook/TSQ as source of truth |
| Phase A (`BillPaymentDraft` + confirm → PIN → execute) | **Shipped** — airtime |
| Phase B data + prepaid electricity | **Shipped** — curated catalogs + meter verify |

## Recommendation

1. **Use BaaS VAS** on the same base URL/stage as transfers — do not add a separate Open API client for Phase A.
2. Poll/async-resolve with **`requestReference`** (Udara idempotency key), not Rubies' internal `reference` alone.
3. Mirror transfer patterns: confirm → PIN → execute; webhook + TSQ for pending outcomes; `AllowanceService.recordBillPaymentSpend` on EXECUTED.
4. **Recurring** bills remain a separate initiative (scheduler, allowance rules, PIN policy).

## Next steps

- Live end-to-end walkthrough: airtime + data + electricity (prod, user-approved amounts/meters)
- Phase C: recurring (separate initiative)

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-30 | Phase B data + electricity shipped |
| 2026-08-30 | Live prod VAS confirmed; Phase A implementation started |
| 2026-08-28 | Initial spike — blocked pending Rubies confirmation |
