# Initiative: WhatsApp media and spend pushback

Companion spec: [docs/specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](../../docs/specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md)  
Companion tech design: [docs/tech-design/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_TECH.md](../../docs/tech-design/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_TECH.md)

Also amends: [spend-check-before-send](../spend-check-before-send/plan.md) (purpose is no longer a same-turn skip).

## How to use this document

Living document. Update phase status, progress log, checklist, and the tracking table on every state change.

## Problem

Udara refuses voice notes and photos. Users who already stated a purpose still get the send-money wizard immediately, including when the send would be a paid override. The product promise is to challenge spending, not to say yes.

## Evidence

- `WhatsappRouterService.handleAudio` / `handleUnsupportedMedia` send static refusals.
- `WhatsappService.downloadMedia` throws.
- Spend-check skipped when purpose keywords or RENT/FOOD/VENDOR labels were present.

## Scope

- Inbound WhatsApp voice → Deepgram STT → existing text path (always reply in text).
- Inbound images → download → orchestrator vision when the conversation model supports it.
- One coaching beat before every first `transfer_wizard` from chat, including in-allowance and fee-path sends. Insist / reason then proceed. Confirm + PIN unchanged.

## Non-goals

- Per-person caps and recurring transfers.
- Outbound TTS / Udara sending voice notes.
- Documents, location, KYC from photos.
- Weakening confirm, PIN, window lock, or the validator.

## Phase 1 — Inbound media + spend pause

**Status:** in progress  
**Started:** 2026-08-29  
**Completed:**  
**Owner:** engineering

### Deliverables

- [ ] Deepgram listen + Meta media download
- [ ] Image turn into orchestrator (Gemini/Anthropic; others degrade)
- [ ] Validator pauses first send; goldens + spend-check spec amended

### Acceptance tests

- [ ] Voice note with key → transcript routed like text
- [ ] Missing Deepgram key → type-instead copy
- [ ] Image with vision provider attaches bytes for one turn only
- [ ] First send (including landlord/rent) → `reply_only`; proceed turn → wizard

### Progress log

- 2026-08-29: Initiative opened from product request (items 3–5). STT-only; no TTS.

### Risk

- ASR errors launching a send: still validator + wizard + confirm + PIN; transcript is untrusted text.
- Purpose-send goldens must flip to pause.

## Tracking table

| Phase | Description | Status |
| --- | --- | --- |
| 1 | Media STT/vision + first-send coaching | in progress |

Allowed status: `not started` · `in progress` · `blocked` · `completed` · `deleted`

## Deferred

- Deepgram Aura TTS / outbound voice notes.
- PDF/document understanding.

## Decisions

Reply in text this version. Pause all first chat sends one beat, not only vague or fee-path.
