# Initiative: transfer-intent-grounding

Companion spec: [docs/specs/TRANSFER_INTENT_GROUNDING_SPEC.md](../../docs/specs/TRANSFER_INTENT_GROUNDING_SPEC.md)  
Companion tech design: [docs/tech-design/TRANSFER_INTENT_GROUNDING_TECH.md](../../docs/tech-design/TRANSFER_INTENT_GROUNDING_TECH.md)

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

After a successful send (wizard + confirm + PIN, which bypass the orchestrator), the next free-text turn still looks like a transfer to the model. “thank you” and “you’ve done the transfers already” relaunch `transfer_wizard`, sometimes with leftover `extracted_hints`. Chat history has no record that the send completed.

## Evidence

- Uncommitted work on `transfer-hints.util.ts` (`isClosedTransferUtterance`, `isActiveSendUtterance`)
- `ActionValidatorService` blocks `fill_wizard` / `transfer_wizard` on closed utterances and only promotes `reply_only` → wizard on active-send utterances
- Golden cases `thanks_does_not_restart_transfer` and `already_sent_does_not_restart_transfer`
- `TransferConfirmationService.recordCompletedTransferInChat` plus `transferDraft` cancel on `EXECUTED`

## Scope

- Classifier helpers for closed vs active send utterances
- Validator gating and promotion rules
- Orchestrator prompt: thanks / already-sent → `reply_only`; live facts as ground truth
- Inject a system fact into `ConversationSession` after execute; cancel leftover active drafts
- Golden dialogues and unit specs for the above

## Non-goals

- Live-LLM quality evals
- Changing PIN, fee math, or Rubies execute path besides post-success history/draft cleanup
- Rewriting the transfer wizard UI

## Phase 1 — Utterance gates + chat grounding

**Status:** in progress  
**Started:** 2026-08-27  
**Completed:**  
**Owner:** engineering

### Deliverables

- [x] `isClosedTransferUtterance` / `isActiveSendUtterance` + unit tests
- [x] Validator: no wizard/fill on closed send; promote ready send only on active-send text
- [x] Prompt rules for thanks / already-sent and last-completed-transfer facts
- [x] Record completed transfer in active `KEDU` `ConversationSession`; cancel `ACTIVE` drafts on execute
- [x] Golden cases for thanks and already-sent
- [ ] Land remaining uncommitted files; keep this plan in the same PR as the code

### Acceptance tests

- [x] Unit: thanks / “you’ve done the transfers already” closed; “I already sent the account” not closed
- [x] Unit: “send 800 to opay” active; “yes” / “thank you” not active
- [x] Golden: `thanks_does_not_restart_transfer`, `already_sent_does_not_restart_transfer` → `reply_only`
- [x] Specs on transfer-confirmation / account-actions for history inject and draft cancel
- [ ] Targeted Jest green for touched files before merge

### Progress log

- 2026-08-27 — Implementation present in working tree (orchestrator, validator, WhatsApp confirmation, goldens, CLI stubs). Documentation system backfill created this plan + SPEC/TECH without changing that code.

### Risk

Closed-utterance regex is English-centric. False positives on mid-wizard “I already sent the account” were explicitly excluded; watch other “already” phrasings.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Utterance gates + chat grounding | in progress |

## Deferred

- Broader closed-send coverage (other languages, more ack paraphrases)
- E2e scenario for post-success “thank you” (needs funded user + stub/live orchestrator)

## Decisions

None elevated to an ADR. Validator remains the hard gate; the prompt is defense in depth.
