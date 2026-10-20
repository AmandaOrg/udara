# Transfer intent grounding

**Status:** Frozen for the in-progress implementation (amend if behavior changes)  
Initiative: [initiatives/transfer-intent-grounding/plan.md](../../initiatives/transfer-intent-grounding/plan.md)  
Tech design: [../tech-design/TRANSFER_INTENT_GROUNDING_TECH.md](../tech-design/TRANSFER_INTENT_GROUNDING_TECH.md)

## Problem

Users who just completed a send or bill often reply “thank you”, “great”, or “you already sent it”. Amanda must not open another money flow, dump the capability menu, or pretend nothing was sent.

## Goals

- Acknowledgements after a completed send stay chat-only.
- A message that is clearly asking to send money **now** can still open or fill the wizard in the same turn.
- After a successful transfer, conversation history contains a factual “this send succeeded” line so later turns are grounded.

## Non-goals

- Changing confirm-button or PIN UX.
- Letting the model quote wallet balances from memory (already forbidden globally).

## User-visible behavior

1. **Closed send utterance** (for example `thanks`, `thank you`, `great`, `you've done the transfers already`): Amanda replies in character and does **not** start or continue a money wizard or the main menu from that message, even if leftover amount/bank hints are still in the model output. One-word acks (`great`, `thanks`) with no wizard draft skip the orchestrator and send a short ack so a model timeout cannot fall through to the menu.
2. **Mid-wizard “I already sent the account”** is **not** a completed-send ack. The wizard may continue.
3. **Active send** (for example `send 800 to opay`, `lets make a transfer of 200 to …`): if amount plus a destination hint is present, the send-money wizard may open immediately. Bare `yes` / `ok` / `please` do not by themselves promote a chat-only reply into a new wizard.
4. After money actually moves, Amanda’s chat history includes a system fact: amount, recipient name or account, and “succeeded / do not start that transfer again.”
5. Leftover in-progress send-money drafts for that user are cleared when a transfer executes so a later “thanks” cannot resume a stale wizard.

## Edge cases

- Past-tense talk (“I sent money yesterday”) is not an active send.
- Confirm/PIN already on screen: user should tap Confirm or enter PIN; text should not restart the wizard.
- If there is no active conversation session, skipping the history line is allowed (best-effort); the transfer itself still succeeds.

## Safety / PII

The history line uses recipient **account name or account number** already stored on the transaction. Do not add PIN, BVN, or raw Flow payloads.

## Acceptance (observable)

- “thank you” after a success fact does not open send money.
- “great” after a completed airtime/data purchase does not open the main menu.
- “you’ve done the transfers already” after a success fact does not open send money.
- “send 800 to opay” still can open send money when hints are valid.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-31 | Short acks (`great`, `thanks`) after a completed send or bill stay chat-only; they do not open `spending_menu` |
| 2026-08-27 | Initial, verified from uncommitted implementation |
