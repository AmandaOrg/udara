# Product behavior (verified from code)

Stakeholder-facing rules that the running app actually enforces. Cross-feature. Feature-specific observable behavior lives in [specs/](specs/README.md).

**Authority:** this file describes what the code actually does — Nest services, Prisma enums, `.env.example` defaults, unit tests, and golden dialogues. The original PRD is committed at [`✅-Kedu-PRD.pdf`](✅-Kedu-PRD.pdf), but it is historical background and stale in places. Where it disagrees with this file, this file is right. Do not rewrite anything below from the PDF.

Labels used below:

- **Verified** — implemented and covered by code or tests.
- **Configured default** — env-driven; defaults from `.env.example` / CI.
- **Gap** — cited but missing source, or not fully implemented.

---

## Identity

Amanda is a WhatsApp savings agent, not a general assistant. It governs outbound spending from a Rubies wallet the user funds. Value is in holding the user’s stated limits, not in doing everything they ask.

Internal package/DB naming still uses `kedu` / `ConversationPersona.KEDU`. User-facing copy uses Amanda.

---

## Routing: deterministic vs LLM

**Verified.** [`WhatsappRouterService`](../src/whatsapp/whatsapp-router.service.ts):

| Inbound | Path |
| --- | --- |
| Buttons / lists (confirm, cancel, menu, bank, label) | Deterministic handlers |
| WhatsApp Flow reply (KYC or PIN) | `PinGateService` or onboarding Flow handler |
| Pre-account free text | Onboarding stage machine |
| Exact menu shortcuts (`menu`, `help`, “what can you do”, …) | Text list of capabilities, then the tap menu. No LLM |
| Weekly review **Adjust limits** while `AWAITING_LIMIT` | Only a parseable naira amount is an answer. `cancel` / `stop` / `nevermind` keep current limits and stop. Any other text drops the wait (no amount-retry line) and continues as a normal post-onboarding turn. Wait older than 24 hours is dropped. See [specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md](specs/WEEKLY_REVIEW_LIMIT_ESCAPE_SPEC.md) |
| Post-onboarding free text, transcribed voice, or image + caption | Orchestrator `propose_turn` → `ActionValidatorService` → `ActionExecutorService` (after the weekly-limit intercept above, if any) |
| Voice note | Deepgram transcript, then the same path as free text (text replies only) |
| Image | Download + orchestrator (vision when the conversation model supports it) |

There is **no** regex product path that extracts transfer fields from free text. The LLM proposes; the validator disposes. Weekly-limit answers use the same `parseNairaAmount` helper as wizards; they are not transfer extraction.

---

## Spending window

**Configured default.** WAT hours, not process-local time ([`WindowService`](../src/allowance/window.service.ts)):

- Start hour default `11`, end hour default `20` (`hour >= start && hour < end`).
- Window lock is not overridable from chat. Settings changes go through the manager gate.

---

## Allowance and fees

**Configured default**, unit-tested in `FeeCalculatorService`:

| Spend type | When | Fee |
| --- | --- | --- |
| `NORMAL` | Inside window, within today’s allowance | ₦0 |
| `EARLY_ACCESS` | Outside the window | ₦1,000 + 0.2% of amount |
| `BORROWED` | Against future allowance | ₦1,000 + 0.4%; waived if yesterday’s surplus covers the amount |

Fee amounts are shown and stored even if `RUBIES_FEES_ACCOUNT_NUMBER` is unset; physical sweep is skipped with a warning until that account is configured.

---

## Transfers

**Verified.**

1. Send-money wizard is a `TransferDraft` step machine, **separate** from `ConversationSession`.
2. Steps: amount → account number → bank selection → label (new recipients only) → typed purpose if **Other**.
3. Orchestrator may start or fill the wizard via `show_surface transfer_wizard` / `fill_wizard` with sanitized hints (amount > 0, 10-digit account, 6-digit bank code, label in RENT/FOOD/VENDOR/OTHER, optional `beneficiary_name` / `purpose_note`). Amounts may be linguistic (`5k`); code parses to naira.
4. A first send **or bill purchase** in chat gets one spend-check question before the wizard, even if they already named a purpose or would pay a fee. Remaining daily allowance is not permission to skip that. After they answer or insist, the matching wizard may open (send-money vs airtime/data/electricity). Transfer purpose is classified via `label_hint` into `RENT | FOOD | VENDOR | OTHER` (`purposeLabel`); Other may also store `purposeNote`. See [specs/SPEND_CHECK_BEFORE_SEND_SPEC.md](specs/SPEND_CHECK_BEFORE_SEND_SPEC.md), [specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md), and [specs/AI_MONEY_INTENTS_SPEC.md](specs/AI_MONEY_INTENTS_SPEC.md).
5. Repeat sends may pre-fill account/bank from saved beneficiaries when the user names someone uniquely (`beneficiary_name` hint), or from a pick list of recent payees when they did not name anyone; confirm and PIN are still required. Unknown names do not invent accounts. See [specs/BENEFICIARY_PREFILL_SPEC.md](specs/BENEFICIARY_PREFILL_SPEC.md).
6. Every send still goes through confirm buttons, then PIN via WhatsApp Flow (`PENDING_PIN` until verified). Money does not move on confirm alone.
7. Thanks, “great”, or “you already sent it” must not relaunch a money wizard or dump the main menu. Short acks after a completed send or bill get a brief in-character reply. See [specs/TRANSFER_INTENT_GROUNDING_SPEC.md](specs/TRANSFER_INTENT_GROUNDING_SPEC.md).

The orchestrator **cannot** execute transfers or invent balances. Surfaces own numbers.

---

## Balances vs allowance

**Verified** (orchestrator prompt + golden dialogues):

- Account/wallet balance → `balance_read` surface.
- Daily/weekly remaining allowance / window status → `limits_read`.
- Mixing them up in chat is a `reply_only` clarification, not a guessed number.

Never quote balances, allowance figures, or account numbers from LLM memory. Live facts are for model reasoning; user-visible figures come from surfaces.

---

## Onboarding

**Verified sequence** (Prisma `OnboardingStage`, not the missing script file):

`DISCOVERY` → `WELCOME` → `IDENTITY` → `FREQUENCY_CHECK` → `PLAN_PROPOSED` (KYC / account create) → `MONEY_STORY` → `AI_REFLECTION` → `STRUCTURED_QUESTIONS` → `PLAN_REVIEW` → `ACCOUNT_CREATED` → `FUNDED` → `FIRST_TRANSACTION` → `COMPLETE`.

KYC (BVN/NIN, DOB, email) is a WhatsApp Flow. It must never be collected as chat text.

The [Canonical Onboarding Script](✅-Kedu-Onboarding-Script.pdf) is committed, but its stage numbering predates this enum and does not match it. The stage machine plus prompt copy in `src/ai/prompts/onboarding.prompts.ts` are what ships.

---

## Managers (settings changes)

**Verified.** [`ManagerService`](../src/manager/manager.service.ts) and [`ManagerConversationService`](../src/manager/manager-conversation.service.ts):

- A user can ask in chat to change their window or limits, or to leave. The orchestrator proposes the `settings_request` surface and code files a `SettingsChangeRequest`. Filing is not changing: nothing about their limits moves.
- Minimum wait: `SETTINGS_CHANGE_MIN_DAYS` (default 7) before a decision is possible. The gate is a timestamp comparison computed once at filing, so no phrasing shortens it.
- Initial substantive "managers" reply is delayed by `MANAGER_INITIAL_REPLY_DELAY_HOURS` (default 3), claimed before generating so it is sent once.
- Decisions are made by an operator via `npm run settings:list` / `npm run settings:decide`, and are final: a decided request cannot be re-decided.
- `disciplineExitedAt` is written only on an approved `EXIT_RESTRICTIONS` decision. Nothing else in the codebase sets it.
- A request can be withdrawn by the user until it is decided (app: `POST /v1/settings-requests/:id/withdraw`).
- Closure requests (`ACCOUNT_DELETION`) are not decided here: `settings:decide` refuses them. See Closing an account below.

Until 2026-09-05 this section read "Verified" while nothing outside `src/manager/` called either entry point — the terms promised a path the code could not reach. See [ADR-0001](decisions/0001-settings-request-surface.md).

## Closing an account

**Built in P9, app only.** The app API is off unless `APP_API_ENABLED=true`. The rules are [ADR-0003](decisions/0003-account-closure-and-retention.md).
- **Asking.** In the app, `POST /v1/account/deletion` needs a zero balance (checked live), no payment in progress, and the PIN if one is set. Someone who asks in chat or by email has the request filed for them by ops (`npm run account:request`). The chat model cannot file one.
- **Waiting.** The request can be withdrawn for 7 days. An operator then closes the account (`npm run account:close`) within 30 days of the request, once the balance is still zero.
- **Closing.** The user is told by chat and email, then signed out everywhere. Their phone number is freed for a new account.
  - **Account holders:** the identity given at account opening, the payment records and the conversation are kept for six years. Everything else is erased.
  - **Someone who never opened an account:** erased entirely.
- **After closing.** A closed account is never messaged again. A later credit to its old account number alerts ops.

## Recipients

**Verified.** First send to an unknown account goes through tagging/confirmation. Labels: RENT, FOOD, VENDOR, OTHER. Other may include a short typed `purposeNote`. Saved nicknames are listed in live facts; the model must not invent account numbers.

---

## Bill payments (airtime, data, electricity)

**Verified.** Menu plus orchestrator surfaces `bill_payment_wizard`, `data_bundle_wizard`, `electricity_wizard`. Chat may prefill amount / network / phone / meter / DisCo from sanitized hints. Data bundles stay a list. Same confirm → PIN as transfers, including the re-quote when Confirm comes more than 10 minutes after the quote or the terms moved, and cancelling a PIN-awaiting purchase (with a message) when the user moves on. See [specs/BILL_PAYMENTS_SPEC.md](specs/BILL_PAYMENTS_SPEC.md) and [specs/AI_MONEY_INTENTS_SPEC.md](specs/AI_MONEY_INTENTS_SPEC.md).

---

## Sensitive data

**Verified.**

- PIN setup/entry and KYC only via WhatsApp Flows ([whatsapp-flows/](whatsapp-flows/)).
- Persist redacted message bodies (`sensitive-fields.util` / WhatsApp message service).
- Inbound voice transcripts and image captions may be stored as `textBody`. Audio and image bytes are not persisted.
- HMAC on webhooks uses raw request bytes (`main.ts` `rawBody: true`).
- Unsigned WhatsApp/Rubies webhooks are accepted only when the corresponding secret is blank (local/e2e). Production must set secrets.

---

## Voice and inbound media

**Verified.** The shipped writing voice is [`src/ai/prompts/kedu-persona.prompts.ts`](../src/ai/prompts/kedu-persona.prompts.ts): lowercase friendly texting, strict on rules, chunked bubbles, no em dashes, no corporate-bank voice. The [Character & Tone System Prompt](✅-Kedu-Character-Tone-Prompt.pdf) it was derived from is committed as background.

Inbound WhatsApp voice notes are transcribed (Deepgram) and handled as text. Replies stay text. Photos may be understood this turn when the conversation model supports vision; they are not a KYC path. See [specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md](specs/WHATSAPP_MEDIA_AND_SPEND_PUSHBACK_SPEC.md).

---

## Surfaces the model may propose

Eligible predicates in [`surface-registry.ts`](../src/orchestrator/surface-registry.ts): `balance_read`, `limits_read`, `account_details`, `transfer_wizard`, `bill_payment_wizard`, `data_bundle_wizard`, `electricity_wizard`, `spending_menu`, `spend_summary`, `pin_reset`, `settings_request`. Unknown or ineligible keys are downgraded to `reply_only`. Medium/missing confidence is text-only unless the validator promotes a ready send or bill, which the transfer-intent, spend-check, and AI money-intents specs gate.

---

## Security boundaries

The invariants that protect funds and identity documents are listed as S1–S12 in [SECURITY.md](SECURITY.md), which is the mandatory review gate for any change here.
