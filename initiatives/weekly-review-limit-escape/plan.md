# Initiative: weekly-review-limit-escape

Companion spec: `docs/specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md`  
Companion tech design: `docs/tech-design/WEEKLY_REVIEW_LIMIT_ESCAPE_TECH.md`

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change. Do not leave the table stale relative to phase headers.

## Problem

After a user taps **Adjust limits** on the Sunday weekly review, every later WhatsApp text is treated as a daily-limit number. Greetings, balance questions, and send-money intents get `"that didn't read as an amount. how much a day should I work with?"` until they send a number inside the 2× plan cap. A too-high number (e.g. ₦7,000 vs a ₦2,000 plan) also leaves the review open, so the trap lasts into the next day.

## Evidence

Production screenshots: `Hi`, `Hello`, `I want to send money`, and `Hi what's the balance` all received the amount-retry line. `7000` got the 2×-ceiling refusal, then the next day's greeting hit the same prompt.

Code: [`WhatsappRouterService.handleUserUtterance`](../../src/whatsapp/whatsapp-router.service.ts) calls `handleLimitText` for **all** text while `WeeklyReview.status === AWAITING_LIMIT`. [`WeeklyReviewService.handleLimitText`](../../src/whatsapp/weekly-review.service.ts) re-prompts on parse failure and on ceiling reject without completing the review. No TTL.

## Scope

- Amount-only intercept for `AWAITING_LIMIT`
- Silent abandon + fall-through for non-amount text
- Explicit cancel words ack and stop
- 24h stale abandon; abandon leftover `AWAITING_LIMIT` when a newer week's recap is sent
- Docs: routing table, initiative companions

## Non-goals

- Changing the 2× ceiling or weekly-review recap copy
- Orchestrator filling weekly limits from free text
- Transfer/bill amount parsers
- Data backfill for stuck production rows (first non-amount message after deploy unsticks)

## Phase 1 — Escape, TTL, and routing

**Status:** completed  
**Started:** 2026-09-02  
**Completed:** 2026-09-02  
**Owner:**

### Deliverables

- [x] `WeeklyReview.updatedAt` + TTL in `getReviewAwaitingLimit`
- [x] Router intercepts parseable amounts only
- [x] Spec, tech design, PRODUCT_BEHAVIOR, summary

### Acceptance tests

- [x] Jest: non-amount does not re-prompt; ceiling reject stays open; 24h stale; new week abandons old wait
- [x] Jest: router `"Hi"` / balance with awaiting review → orchestrator; `"7000"` → `handleLimitText`

### Progress log

- 2026-09-02 — Implemented amount-only intercept, silent/acked abandon, 24h TTL, and older-week cleanup on `sendReview`.

### Risk

- Completing on divert means they must wait until next Sunday (or ask via manager path) to adjust again. Preferred over stealing a later `"5000"` meant as a transfer.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Escape hatch, 24h TTL, amount-only router intercept | completed |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Deferred

- Orchestrator-aware weekly-limit fill from ordinary language.

## Decisions

None (no ADR; S1–S12 unchanged).
