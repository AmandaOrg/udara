# WhatsApp media and spend pushback

**Status:** Frozen for the in-progress implementation (amend if behavior changes)  
Initiative: [initiatives/whatsapp-media-and-spend-pushback/plan.md](../../initiatives/whatsapp-media-and-spend-pushback/plan.md)  
Tech design: [../tech-design/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_TECH.md](../tech-design/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_TECH.md)

Spend-check rules that this feature changes are also in [SPEND_CHECK_BEFORE_SEND_SPEC.md](SPEND_CHECK_BEFORE_SEND_SPEC.md).

## Problem

Users cannot talk or send a photo in WhatsApp. Udara opens send money as soon as a purpose is obvious, including when they would pay early-access or borrow fees.

## Goals

- Voice notes are understood as chat (text replies only).
- A photo can inform the conversation (receipt, screenshot of a payee, what the spend is for).
- Udara challenges every new send in chat first. If they insist or give a reason and still want it, the existing wizard → confirm → PIN path runs, including paid overrides.

## Non-goals

- Udara speaking with a voice note.
- Recurring payments or per-person caps.
- Treating a photo as KYC (BVN/NIN/DOB stay Flows).
- Skipping confirm, PIN, or the spending-window lock.

## User-visible behavior

### Voice

1. User sends a voice note. If speech-to-text is configured and the audio can be heard, Udara treats the words like a typed message (onboarding, menu shortcut, or orchestrator).
2. If the key is missing, download fails, or the transcript is empty: ask them to type it.
3. PIN and KYC are never collected from a transcript.

### Images

1. User sends a photo (optional caption). Udara may use the picture for spend context this turn.
2. If the photo looks like a government ID, Udara stays in chat and points them at the official KYC flow. It does not extract NIN, BVN, or date of birth.
3. Account numbers seen in a screenshot are only hints. Money still uses the wizard, confirm card, and PIN with values from the database.
4. Documents and location stay “send that as text.”
5. If the picture cannot be opened or the model cannot see images, Udara says so and does not pretend it saw the photo.

### Spend pushback

1. The first time they ask to send money in this chat beat (including “send 5k to my landlord”), Udara replies in chat only. It asks why / whether it is needed, including when they would pay a fee.
2. After that question, a purpose, “just send it”, or a short go-ahead opens send money using details already collected. “Never mind” stays chat-only.
3. Confirm buttons and PIN are unchanged. Fees still show on the confirm card.

## Edge cases

- Menu **Send money** button still opens the wizard (not free text).
- Mid-wizard field answers are not a new first send.
- Thanks / “you already sent it” still must not relaunch send money.
- Window closed: coaching does not unlock the window.

## Safety / PII

Do not persist audio or image bytes. Persist the transcript (and image caption) as message text. Do not log API keys or media bytes. Do not put PIN/KYC in transcripts or captions.

## Acceptance (observable)

- Voice with STT configured → same routing as typed text for that wording.
- Voice without STT → type-instead copy.
- First “send … to landlord” → no wizard that turn.
- After the check, “it’s for rent” / “send it anyway” → wizard allowed.
- Over-allowance / outside-window wording on the first send → still no wizard that turn.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-29 | Initial |
