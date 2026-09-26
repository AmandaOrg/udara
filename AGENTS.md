# Agent and collaborator guide

Read this before editing Udara. Tool-neutral: Cursor, Claude Code, humans.

## Read order

1. This file
2. [docs/SECURITY.md](docs/SECURITY.md) — mandatory gate, this product moves real money
3. [docs/README.md](docs/README.md)
4. `.cursor/project/summary.md` (module map)
5. The matching initiative / spec / tech design if the task is non-trivial

Do not treat chat history as product authority.

The original PRD, onboarding script, and tone prompt **are** in `docs/` as PDFs. They are historical background, not specification — parts are stale, and the code is correct where they disagree. Never change code or rewrite a behavior doc to match them. See [docs/README.md](docs/README.md#founding-pdfs--historical-not-authority).

## Source-of-truth hierarchy

1. **Code + tests** (what actually runs)
2. **docs/specs/** (observable behavior)
3. **docs/tech-design/** and **docs/ARCHITECTURE.md** (how)
4. **initiatives/*/plan.md** (status of work)
5. The founding PDFs in `docs/` and the `PRD §…` comments that cite them (background only, and stale in places)

If they disagree, fix the docs in the same change as the code, or flag the gap. Do not silently “align” money or PIN behavior to the PRD.

## Security first

Udara moves real money and handles PIN, BVN, NIN, and DOB. [docs/SECURITY.md](docs/SECURITY.md) defines twelve invariants (S1–S12) and a per-change-type checklist. Both are mandatory.

Never weaken a guard, the validator, the confirm step, or the PIN step to make something work. Never add a bypass flag. Never log or commit a secret. If a change would alter S1–S12 or widen what the LLM can trigger, stop and ask; record the answer in the initiative plan.

## Hard product constraints

- **Deterministic vs LLM:** buttons, lists, Flows, PIN = code. Post-onboarding free text = orchestrator `propose_turn` only. No regex transfer extraction.
- **Model proposes, validator disposes.** Medium/unknown/ineligible → `reply_only`. Never execute transfers from the LLM.
- **Surfaces own numbers.** Never quote balance, allowance, or account number from model memory.
- **KYC and PIN** only through a form: a WhatsApp Flow, or the app's `/v1/forms/kyc` and `/v1/forms/pin`, never chat text. Values travel to the handler only in the in-memory `sensitive` map. Never persist or log raw PIN/BVN/NIN. (Amended by [ADR-0002](docs/decisions/0002-app-channel-and-auth.md).)
- **Spending window** is WAT wall-clock, not overridable in chat.
- **Confirm then PIN** before money moves.
- Package name `kedu` vs product **Udara** — user-facing copy is Udara.

## Coding conventions

- Nest module / service / `*.spec.ts` colocation
- Prisma for schema; migrations required for model changes
- Match the file’s existing quote style. `npm run lint` runs `--fix`, so it reformats rather than checks — lint only the files you touched (`npx eslint <paths>`). Never delete `.gitattributes`; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Comment why, not what
- `forwardRef` only for existing WhatsApp circulars
- Send to users only through `ChannelMessenger` (`src/messaging/`), never `WhatsappService` directly. A send outside an inbound event (cron, provider webhook) is labelled `proactive` or `transactional`
- What a user says, on either channel, is routed by `ConversationRouterService` (`src/conversation/`) inside one `TurnService.run` per event. Add conversational behaviour there, not in the WhatsApp router or the app's chat service
- Dry-run + `AI_PROVIDER=stub` for local/e2e unless the task is live-LLM

## Initiatives

Non-trivial work: create `initiatives/<slug>/plan.md` from the template **before** (or in the same PR as) production code. Link a spec and a tech design. Update the tracking table and [initiatives/README.md](initiatives/README.md) when status changes.

## Documentation update triggers

| You changed | Also update |
| --- | --- |
| A security invariant, guard, or redaction rule | `docs/SECURITY.md` + `scripts/check-security.js` + an ADR |
| User-visible behavior | spec + plan + `docs/PRODUCT_BEHAVIOR.md` if cross-cutting |
| Module graph, models, env | `docs/ARCHITECTURE.md` / `DEVELOPMENT.md` + `.cursor/project/summary.md` |
| Tests / verification | `docs/TESTING.md` |
| Orchestrator validator / surfaces / goldens | golden JSON + orchestrator Cursor rule still applies |
| Structure or conventions | summary.md (surgical) |

## Completion checklist

- [ ] `npm run security:check` and the relevant section of [docs/SECURITY.md](docs/SECURITY.md)
- [ ] Targeted tests for touched units (`npx jest <paths>`)
- [ ] Golden dialogues if validator/intent/surfaces changed (`npm run orchestrator:golden`)
- [ ] Relevant e2e subset if webhooks/wizards/HMAC changed
- [ ] `npm run docs:check`
- [ ] Initiative plan / spec / tech / summary updated when required
- [ ] No secrets in git; no PIN/KYC in fixtures

Report the commands you actually ran. Do not claim a check passed that you did not run.

## Commands

See [README.md](README.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Do not add features to CI beyond what `.github/workflows/ci.yml` already runs unless asked.
