# Beneficiary prefill on repeat sends

**Status:** Frozen  
Initiative: [initiatives/beneficiary-prefill/plan.md](../../initiatives/beneficiary-prefill/plan.md)  
Tech design: [../tech-design/BENEFICIARY_PREFILL_TECH.md](../tech-design/BENEFICIARY_PREFILL_TECH.md)

## Problem

Repeat sends require re-entering account and bank even when the user already sent to that person.

## Goals

- Persist beneficiaries on successful sends (`Recipient` + `nickname`, `lastUsedAt`).
- Free text like “send 5k to james” pre-fills account/bank from a **unique** saved match.
- Skip only wizard lookup steps — **confirm and PIN still required**.

## Non-goals

- Auto-execute or skip PIN
- Inventing account numbers from names in code (model proposes `beneficiary_name`; code resolves)

## User-visible behavior

1. **Unique match:** wizard jumps to name-enquiry + confirm (same as a known recipient today).
2. **Ambiguous match:** list to pick which “james” — no transfer draft until they choose.
3. **No match:** normal wizard (ask account/bank). No invented account numbers.
4. **Send with no name:** if saved payees exist, show a pick list of recent beneficiaries.

## Acceptance

- Unique nickname → `initiateTransfer` with resolved account/bank; PIN still required after confirm.
- Ambiguous → disambiguation list, no execute.
- Golden: `send 5k to james for rent` → `transfer_wizard` with `beneficiaryName` + `labelHint`.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-31 | Pick list when send has no payee; unknown names stay unfilled ([AI_MONEY_INTENTS_SPEC.md](AI_MONEY_INTENTS_SPEC.md)) |
| 2026-08-28 | Initial |
