# Product behavior (verified from code)

Stakeholder-facing rules that the running app actually enforces. Cross-feature. Feature-specific observable behavior lives in [specs/](specs/README.md).

**Authority:** this file is reconstructed from Nest services, Prisma enums, `.env.example` defaults, unit tests, and golden dialogues. The original PRD is **not in the repo**. Do not treat PRD section numbers in comments as a committed document.

Labels used below:

- **Verified** — implemented and covered by code or tests.
- **Configured default** — env-driven; defaults from `.env.example` / CI.
- **Gap** — cited but missing source, or not fully implemented.

---

## Identity

Udara is a WhatsApp savings agent, not a general assistant. It governs outbound spending from a Rubies wallet the user funds. Value is in holding the user’s stated limits, not in doing everything they ask.

Internal package/DB naming still uses `kedu` / `ConversationPersona.KEDU`. User-facing copy uses Udara.

---

## Routing: deterministic vs LLM

**Verified.** [`WhatsappRouterService`](../src/whatsapp/whatsapp-router.service.ts):

| Inbound | Path |
| --- | --- |
| Buttons / lists (confirm, cancel, menu, bank, label) | Deterministic handlers |
| WhatsApp Flow reply (KYC or PIN) | `PinGateService` or onboarding Flow handler |
| Pre-account free text | Onboarding stage machine |
| Exact menu shortcuts (`menu`, `help`, …) | Main menu, no LLM |
| Post-onboarding free text | Orchestrator `propose_turn` → `ActionValidatorService` → `ActionExecutorService` |

There is **no** regex product path that extracts transfer fields from free text. The LLM proposes; the validator disposes.

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
2. Steps: amount → account number → bank selection → label (new recipients only).
3. Orchestrator may start or fill the wizard via `show_surface transfer_wizard` / `fill_wizard` with sanitized hints (amount > 0, 10-digit account, 6-digit bank code, label in RENT/FOOD/VENDOR/OTHER).
4. A vague send (no stated purpose) gets one spend-check question in chat before the wizard. Remaining daily allowance is not permission to skip that. Purpose already in the message (rent, landlord, food, …) can still open the wizard the same turn. See [specs/SPEND_CHECK_BEFORE_SEND_SPEC.md](specs/SPEND_CHECK_BEFORE_SEND_SPEC.md).
5. Every send still goes through confirm buttons, then PIN via WhatsApp Flow (`PENDING_PIN` until verified). Money does not move on confirm alone.
6. Thanks / “you already sent it” must not relaunch the wizard. See [specs/TRANSFER_INTENT_GROUNDING_SPEC.md](specs/TRANSFER_INTENT_GROUNDING_SPEC.md).

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

**Gap:** `docs/Udara-Onboarding-Script` is not in the repo. Prompt copy in `src/ai/prompts/onboarding.prompts.ts` and the stage machine are what ships.

---

## Managers (settings changes)

**Verified.** [`ManagerService`](../src/manager/manager.service.ts):

- Minimum wait: `SETTINGS_CHANGE_MIN_DAYS` (default 7) before review eligibility.
- Initial substantive “managers” reply is delayed by `MANAGER_INITIAL_REPLY_DELAY_HOURS` (default 3).
- Gate is a timestamp comparison, independent of how the user phrases the request.

---

## Recipients

**Verified.** First send to an unknown account goes through tagging/confirmation. Labels: RENT, FOOD, VENDOR, OTHER.

---

## Sensitive data

**Verified.**

- PIN setup/entry and KYC only via WhatsApp Flows ([whatsapp-flows/](whatsapp-flows/)).
- Persist redacted message bodies (`sensitive-fields.util` / WhatsApp message service).
- HMAC on webhooks uses raw request bytes (`main.ts` `rawBody: true`).
- Unsigned WhatsApp/Rubies webhooks are accepted only when the corresponding secret is blank (local/e2e). Production must set secrets.

---

## Voice

**Gap + committed proxy.** Tone PDF is missing. Committed identity/voice is [`src/ai/prompts/kedu-persona.prompts.ts`](../src/ai/prompts/kedu-persona.prompts.ts): lowercase friendly texting, strict on rules, chunked bubbles, no em dashes, no corporate-bank voice.

---

## Surfaces the model may propose

Eligible predicates in [`surface-registry.ts`](../src/orchestrator/surface-registry.ts): `balance_read`, `limits_read`, `account_details`, `transfer_wizard`, `spending_menu`, `spend_summary`. Unknown or ineligible keys are downgraded to `reply_only`. Medium/missing confidence is text-only unless the validator promotes a ready send (see transfer-intent spec).
