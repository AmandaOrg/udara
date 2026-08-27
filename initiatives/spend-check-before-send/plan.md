# Initiative: spend check before send

Companion spec: [docs/specs/SPEND_CHECK_BEFORE_SEND_SPEC.md](../../docs/specs/SPEND_CHECK_BEFORE_SEND_SPEC.md)  
Companion tech design: [docs/tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md](../../docs/tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

When someone asks to send money and they still have remaining daily allowance, Udara opens the send-money wizard immediately. It does not pause to ask what the spend is for. Remaining access is treated as permission. That fights the product identity: the value is in not letting people lie to themselves about spending.

## Evidence

- Orchestrator prompt: “Never stall a send… launching transfer_wizard this turn is required.”
- Validator promotes `reply_only` → `transfer_wizard` on an active-send utterance plus amount and destination.
- Goldens such as `tx_ready_send_not_stalled_on_reply_only` encode same-turn launch for a vague Opay send.
- Identity in `kedu-persona.prompts.ts`: value lives in the moments Udara says no.

## Scope

- One chat beat (spend check) before `transfer_wizard` when the send has no stated purpose.
- Same-turn wizard when purpose is already in the message (rent, landlord, food, …) or a non-OTHER label hint.
- After the check, answering / insisting still opens the wizard (hints kept on the session).
- Prompt, validator, goldens, PRODUCT_BEHAVIOR.

## Non-goals

- Changing confirm buttons, PIN, fees, or Rubies execute.
- Multi-turn interrogation or a new wizard step.
- Blocking sends that fit remaining allowance (this is a question, not a hard no).
- Inventing a missing PRD script of exact questions.

## Phase 1 — Spend-check gate

**Status:** in progress  
**Started:** 2026-08-27  
**Completed:**  
**Owner:** engineering

### Deliverables

- [ ] Spec + tech design registered
- [ ] Validator does not launch/promote a vague first send
- [ ] Session remembers pending send hints across the check
- [ ] Prompt: remaining allowance is not permission
- [ ] Goldens updated; new proceed-after-check case

### Acceptance tests

- [ ] “send 800 to opay” with no why → `reply_only` (no wizard)
- [ ] “send 5k to my landlord for rent” → wizard same turn
- [ ] After the check, “it’s for food” / “just send it” → wizard
- [ ] Closed-send / thanks still must not relaunch

### Progress log

- 2026-08-27: Initiative opened from production observation (wizard skips coaching when allowance remains).

### Risk

- Re-introduces “let’s get that ready” stall if the second turn does not launch. Mitigate with session hints + promote on proceed, and live-facts `spend_check` mode.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Spend-check gate | in progress |

## Deferred

- Stronger borrow/overspend copy when amount exceeds remaining today (confirm card already shows fees).
- Asking a second question after they state a purpose.

## Decisions

Remaining daily access is not a skip condition for the check. Purpose already in the utterance is.
