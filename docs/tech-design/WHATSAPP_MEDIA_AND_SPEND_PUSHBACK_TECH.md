# WhatsApp media and spend pushback — tech design

- Spec: [../specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](../specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md)
- Plan: [../../initiatives/whatsapp-media-and-spend-pushback/plan.md](../../initiatives/whatsapp-media-and-spend-pushback/plan.md)

## Approach

Keep `propose_turn` → `ActionValidatorService`. Media stays in WhatsApp: download from Meta, Deepgram listen, optional image bytes on **this** orchestrator turn only. Orchestrator module still has no WhatsApp send and no Rubies.

Pattern copied from Amanda’s Node backend (not Amanda-ml-service): REST `POST /v1/listen`, `Authorization: Token`, Nova-3, `detect_language`. No TTS.

## Data / types

No Prisma migration. `WhatsappMessage.textBody` may hold a transcript or image caption. `ConversationSession.contextData.spendCheck` still holds sanitized `TransferWizardHints` (optional `spendReason` string).

`LlmMessage` may include `images?: { mimeType; data }` (base64). History JSON stores text only.

Env: `DEEPGRAM_API_KEY`, optional `DEEPGRAM_STT_MODEL` (default `nova-3`).

## Control flow

1. AUDIO: `downloadMedia` → Deepgram → persist transcript → same path as `handleText`.
2. IMAGE: `downloadMedia` → `handleMessage(user, caption, { image })`. Vision on Gemini/Anthropic; stub/Bedrock/OpenRouter: live-facts “image not visible”.
3. First active send: `shouldPauseForSpendCheck` is true whenever `isActiveSendUtterance` (purpose no longer skips). Validator forces `reply_only`. Session stores hints. Proceed / abort helpers unchanged.
4. Confirm + PIN unchanged.

## Invariants

- S8: every model turn still `validator.validate`.
- Transcripts and captions are untrusted. Hints sanitized; execution re-reads DB.
- No `skipPin` / `allowOutsideWindow`.
- Do not log media bytes or `DEEPGRAM_API_KEY`.

## Tests

- Unit: `deepgram.service.spec.ts`, `whatsapp.service` download (mocked HTTP), router audio/image, `llm-vision.util.spec.ts`, `transfer-hints.util.spec.ts`, `action-validator.service.spec.ts`, `orchestrator.service.spec.ts`
- Golden: first purpose send → `expected_surface` null; `spend_check_proceed_launches_wizard` unchanged
- Commands: `npx jest src/whatsapp src/orchestrator src/ai/llm-vision.util.spec.ts`, `npm run orchestrator:golden`

## Rollout / risk

Missing Deepgram key keeps the old type-instead copy. ASR mistakes cannot move money.

## Changelog

| Date | Change |
| --- | --- |
| 2026-08-29 | Initial |
