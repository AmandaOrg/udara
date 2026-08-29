# Spend check before send

**Status:** Frozen for the in-progress implementation (amend if behavior changes)  
Initiative: [initiatives/spend-check-before-send/plan.md](../../initiatives/spend-check-before-send/plan.md)  
Tech design: [../tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md](../tech-design/SPEND_CHECK_BEFORE_SEND_TECH.md)

Amended by [WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md): purpose on the first send is no longer a same-turn skip.

The original PRD is committed in `docs/` but is historical background, not spec. Rules below are verified against identity copy plus this implementation.

## Problem

Users who still have remaining daily allowance can say they want to send money and Udara prepares the transfer without asking what it is for. “You can still spend today” is treated as “go ahead.”

## Goals

- A first send in chat gets **one** in-character question before the send-money wizard (vague or with a purpose).
- Remaining allowance is not permission to skip that question. Paying early-access or borrow fees is not a skip either.
- After the question, answering or insisting still prepares the send (does not loop forever).

## Non-goals

- Hard-blocking a send that fits today’s allowance after they insist.
- New wizard steps, buttons, or PIN changes.
- A long counselling script.

## User-visible behavior

1. **First send** (for example `send 800 to opay`, `send 5k to my landlord for rent`): Udara replies in chat only. It asks what the money is for / whether it is actually needed. It does **not** open send money on that turn.
2. **After the check:** if they give a purpose, say send it anyway, or otherwise still want the send, Udara opens the wizard that turn using details already collected. If they back off (`never mind`, `don't send`), it stays chat-only and does not open the wizard.
3. Mid-wizard field answers, confirm, and PIN are unchanged. Thanks / “you already sent it” still must not start a send (see transfer-intent grounding).

## Edge cases

- Label hints do not skip the first-send pause. They still help resume after the check.
- Window closed: do not open the wizard; the spend check does not override the window lock.
- Bare `yes` after the check may proceed; bare `yes` with no check in progress still does not invent a new send by itself.

## Safety / PII

No new collection of PIN, BVN, or NIN. Purpose is free text in the existing chat session.

## Acceptance (observable)

- Vague Opay/amount send → no `transfer_wizard` on that turn.
- Landlord/rent (or similar) first send → no `transfer_wizard` on that turn.
- After a spend-check question, a purpose or “just send it” → `transfer_wizard` allowed.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-27 | Initial |
| 2026-08-29 | Purpose no longer skips the first-send pause |
