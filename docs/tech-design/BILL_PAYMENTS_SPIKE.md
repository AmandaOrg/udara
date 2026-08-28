# Bill payments — Rubies API spike

**Status:** Blocked on API confirmation (2026-08-28)  
Initiative: [initiatives/bill-payments/plan.md](../../initiatives/bill-payments/plan.md)

## Question

Can Udara vend **one-off airtime** (and later data / Nepa electricity) by debiting the **same Rubies BaaS wallet** users already fund for transfers?

## What this codebase uses today

[`RubiesService`](../../src/rubies/rubies.service.ts) targets **RubiesSme BaaS**:

- Host: `RUBIES_BASE_URL` (default `https://api-sme-dev.rubies.ng`)
- Paths: `/{stage}/baas-wallet/*`, `/{stage}/baas-transaction/*`
- Implemented: `create-wallet`, `retrieve-wallet-details`, `name-enquiry`, `balance-enquiry`, `fund-transfer`, `tsq`, `bank-list`
- **No** airtime, biller lookup, or vending methods in code or committed docs

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
| BaaS OpenAPI at `api-sme-dev.rubies.ng/v3/api-docs/BAAS-API` lists airtime/biller paths | **Not verified in repo** — needs live fetch with dev credentials |
| Open API airtime debits a user's BaaS wallet with existing `RUBIES_API_KEY` | **Unknown / likely no** — separate host and auth model |
| Phase A (`BillPaymentDraft` + confirm → PIN → execute) safe to build | **No** — blocked until debit path is confirmed |

## Recommendation

1. **Do not** add `BillPaymentDraft` or orchestrator `bill_payment_wizard` until product/engineering confirms with Rubies which API + credentials debit the funded wallet.
2. If BaaS exposes vending: extend `RubiesService` on the same base URL/stage; mirror transfer pending/TSQ patterns.
3. If only Open API: separate client module, credential env vars, and explicit product sign-off that wallet balances are shared.
4. **Recurring** bills remain a separate initiative (scheduler, allowance rules, PIN policy).

## Next steps when unblocked

- Phase A: one-off airtime only (`BillPaymentDraft`, `Transaction`-like status enum, reuse `PinGateService`)
- Phase B: data bundles + Nepa/electricity (biller verification step)
- Phase C: recurring (out of scope here)

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-28 | Initial spike — blocked pending Rubies confirmation |
