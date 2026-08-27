# Agent and collaborator guide

Read this before editing Udara. Tool-neutral: Cursor, Claude Code, humans.

## Read order

1. This file
2. [docs/README.md](docs/README.md)
3. `.cursor/project/summary.md` (module map)
4. The matching initiative / spec / tech design if the task is non-trivial

Do not treat chat history as product authority. Do not invent the missing PRD, onboarding script, or tone PDF; see source gaps in `docs/README.md`.

## Source-of-truth hierarchy

1. **Code + tests** (what actually runs)
2. **docs/specs/** (observable behavior)
3. **docs/tech-design/** and **docs/ARCHITECTURE.md** (how)
4. **initiatives/*/plan.md** (status of work)
5. Comments that cite “PRD §…” (hints only; PRD file is not in repo)

If they disagree, fix the docs in the same change as the code, or flag the gap. Do not silently “align” money or PIN behavior to a remembered PRD.

## Hard product constraints

- **Deterministic vs LLM:** buttons, lists, Flows, PIN = code. Post-onboarding free text = orchestrator `propose_turn` only. No regex transfer extraction.
- **Model proposes, validator disposes.** Medium/unknown/ineligible → `reply_only`. Never execute transfers from the LLM.
- **Surfaces own numbers.** Never quote balance, allowance, or account number from model memory.
- **KYC and PIN** only via WhatsApp Flows. Never persist or log raw PIN/BVN/NIN.
- **Spending window** is WAT wall-clock, not overridable in chat.
- **Confirm then PIN** before money moves.
- Package name `kedu` vs product **Udara** — user-facing copy is Udara.

## Coding conventions

- Nest module / service / `*.spec.ts` colocation
- Prisma for schema; migrations required for model changes
- Match the file’s existing quote style
- Comment why, not what
- `forwardRef` only for existing WhatsApp circulars
- Dry-run + `AI_PROVIDER=stub` for local/e2e unless the task is live-LLM

## Initiatives

Non-trivial work: create `initiatives/<slug>/plan.md` from the template **before** (or in the same PR as) production code. Link a spec and a tech design. Update the tracking table and [initiatives/README.md](initiatives/README.md) when status changes.

## Documentation update triggers

| You changed | Also update |
| --- | --- |
| User-visible behavior | spec + plan + `docs/PRODUCT_BEHAVIOR.md` if cross-cutting |
| Module graph, models, env | `docs/ARCHITECTURE.md` / `DEVELOPMENT.md` + `.cursor/project/summary.md` |
| Tests / verification | `docs/TESTING.md` |
| Orchestrator validator / surfaces / goldens | golden JSON + orchestrator Cursor rule still applies |
| Structure or conventions | summary.md (surgical) |

## Completion checklist

- [ ] Targeted tests for touched units (`npx jest <paths>`)
- [ ] Golden dialogues if validator/intent/surfaces changed (`npm run orchestrator:golden`)
- [ ] Relevant e2e subset if webhooks/wizards/HMAC changed
- [ ] `npm run docs:check`
- [ ] Initiative plan / spec / tech / summary updated when required
- [ ] No secrets in git; no PIN/KYC in fixtures

## Commands

See [README.md](README.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Do not add features to CI beyond what `.github/workflows/ci.yml` already runs unless asked.
