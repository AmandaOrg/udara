# Transfer intent grounding — tech design

- Spec: [../specs/TRANSFER_INTENT_GROUNDING_SPEC.md](../specs/TRANSFER_INTENT_GROUNDING_SPEC.md)
- Plan: [../../initiatives/transfer-intent-grounding/plan.md](../../initiatives/transfer-intent-grounding/plan.md)

## Approach

Keep the LLM proposing `propose_turn`. Put **hard** closed-send and active-send rules in TypeScript so a confused model cannot relaunch the wizard. Ground later turns by writing a one-line assistant fact into `ConversationSession` after execute, because wizard/confirm/PIN never pass through the orchestrator.

Does not change Rubies transfer execution, PIN Flows, or fee math except calling existing post-success paths.

## Data / types

- No schema migration.
- `TransferWizardHints` unchanged; sanitizer still rejects implausible values.
- New helpers on [`src/orchestrator/transfer-hints.util.ts`](../../src/orchestrator/transfer-hints.util.ts):
  - `isClosedTransferUtterance(text)`
  - `isActiveSendUtterance(text)` (false if closed; false for bare acks like `yes`/`ok`)

Conversation append shape:

```ts
{ role: 'assistant', content: 'System: ₦… to <name|account> succeeded. Do not start that transfer again.', at: ISOString }
```

Persona filter: `ConversationPersona.KEDU`, `ConversationSessionStatus.ACTIVE`.

## Control flow

1. User text → `OrchestratorService` → model `propose_turn`.
2. `ActionValidatorService.validate(..., userText)`:
   - `closedSend` → `fill_wizard` and `show_surface transfer_wizard` become `reply_only`.
   - `sendingNow` + actionable hints → may promote `reply_only` / medium confidence to `show_surface transfer_wizard`.
   - Bare `yes` is not `sendingNow`, so promotion does not fire; a **high-confidence** `show_surface transfer_wizard` still runs unless `closedSend`.
3. On `TransactionStatus.EXECUTED` in `TransferConfirmationService`:
   - `transferDraft` `ACTIVE` → `CANCELLED` for that user
   - `recordCompletedTransferInChat` (best-effort; failures log, do not fail the transfer)

Prompt ([`orchestrator-system.prompt.ts`](../../src/orchestrator/prompts/orchestrator-system.prompt.ts)): thanks / already-sent → `reply_only`; live facts “Last completed transfer” is ground truth.

## Invariants

- Surfaces still own balances; this work does not let the model invent numbers.
- “I already sent the account” must not match closed-send.
- Validator, not the prompt, is the last gate.

## Tests

- Unit: `transfer-hints.util.spec.ts`, `action-validator.service.spec.ts`, `transfer-confirmation.service.spec.ts`, `account-actions.service.spec.ts`
- Golden: `thanks_does_not_restart_transfer`, `already_sent_does_not_restart_transfer`
- Commands: `npx jest src/orchestrator src/whatsapp/transfer-confirmation.service.spec.ts src/whatsapp/account-actions.service.spec.ts` then `npm run orchestrator:golden`

## Rollout / risk

Ship with the existing uncommitted orchestrator/WhatsApp diff. Regex coverage is English-only; add goldens before widening patterns.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-27 | Initial, matches working-tree implementation |
