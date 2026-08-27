# Spend check before send

**Status:** Frozen for the in-progress implementation (amend if behavior changes)  
Initiative: [initiatives/spend-check-before-send/plan.md](../../initiatives/spend-check-before-send/plan.md)  
Tech design: [../tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md](../tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md)

The original PRD is not in the repo. Rules below are product intent verified against identity copy plus this implementation.

## Problem

Users who still have remaining daily allowance can say they want to send money and Udara prepares the transfer without asking what it is for. “You can still spend today” is treated as “go ahead.”

## Goals

- A vague send (amount and/or destination, no purpose) gets **one** in-character question before the send-money wizard.
- Remaining allowance is not permission to skip that question.
- A send that already states a purpose can still open the wizard in the same turn.
- After the question, answering or insisting still prepares the send (does not loop forever).

## Non-goals

- Refusing a send that fits today’s allowance.
- New wizard steps, buttons, or PIN changes.
- A long counselling script.

## User-visible behavior

1. **Vague send** (for example `send 800 to opay`, `I want to send money now`, `lets make a transfer of 200 to …` with no why): Udara replies in chat only. It asks what the money is for (or whether it is actually needed). It does **not** open send money on that turn.
2. **Purpose already stated** (for example `send 5k to my landlord for rent`, `pay food`): send money may open immediately, same as today.
3. **After the check:** if they give a purpose, say send it anyway, or otherwise still want the send, Udara opens the wizard that turn using details already collected. If they back off (`never mind`, `don't send`), it stays chat-only and does not open the wizard.
4. Mid-wizard field answers, confirm, and PIN are unchanged. Thanks / “you already sent it” still must not start a send (see transfer-intent grounding).

## Edge cases

- Label hint `RENT` / `FOOD` / `VENDOR` counts as purpose; `OTHER` does not skip the check by itself.
- Window closed: do not open the wizard; the spend check does not override the window lock.
- Bare `yes` after the check may proceed; bare `yes` with no check in progress still does not invent a new send by itself.

## Safety / PII

No new collection of PIN, BVN, or NIN. Purpose is free text in the existing chat session.

## Acceptance (observable)

- Vague Opay/amount send → no `transfer_wizard` on that turn.
- Landlord/rent (or similar) send → `transfer_wizard` allowed same turn.
- After a spend-check question, a purpose or “just send it” → `transfer_wizard` allowed.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-27 | Initial |
