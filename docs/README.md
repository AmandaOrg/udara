# Documentation index

Canonical home for Udara knowledge that should survive a chat session. Code comments explain *why a line exists*. These files explain *what the product does*, *how the system is shaped*, and *what is in flight*.

## Ownership map

| Kind | Path | Owner of truth | Update when |
| --- | --- | --- | --- |
| Security gate (mandatory) | [SECURITY.md](SECURITY.md) | Invariants + `scripts/check-security.js` | A guard, redaction rule, or LLM boundary changes |
| Product behavior (verified) | [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md) | Code + this file | Discipline rules, routing, or safety boundaries change |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) | Nest modules + Prisma | Module graph, request flow, or integrations change |
| Orchestrator direction | [ai-orchestrator-architecture-plan.md](ai-orchestrator-architecture-plan.md) | The plan itself | Orchestrator phases land or change scope |
| Development | [DEVELOPMENT.md](DEVELOPMENT.md) | `.env.example` + scripts | Setup, env, or local workflow change |
| Testing | [TESTING.md](TESTING.md) | Jest / e2e / golden runner | Test contract or verification matrix change |
| Feature specs | [specs/](specs/README.md) | Spec + matching tests | Observable behavior changes |
| Tech designs | [tech-design/](tech-design/README.md) | Code | Implementation shape changes |
| Decisions | [decisions/](decisions/README.md) | The ADR | A cross-cutting choice is locked |
| Initiatives | [../initiatives/README.md](../initiatives/README.md) | `plan.md` | Status or scope of work changes |
| WhatsApp Flows | [whatsapp-flows/](whatsapp-flows/) | Meta-published Flow JSON | KYC/PIN forms change |
| Agent contract | [../AGENTS.md](../AGENTS.md) | Collaborators | Working rules change |

## How to use this tree

1. Read [../AGENTS.md](../AGENTS.md) and [SECURITY.md](SECURITY.md) before editing.
2. For behavior questions, start at [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md), then the matching spec.
3. For “where does this live?”, start at [ARCHITECTURE.md](ARCHITECTURE.md) or `.cursor/project/summary.md`.
4. For in-progress work, start at [../initiatives/README.md](../initiatives/README.md).
5. Do not invent missing source documents. List them as gaps.
6. Before opening a pull request, run `npm run security:check` and `npm run docs:check`.

## Founding PDFs — historical, not authority

Three original documents sit in this folder and have been committed since the initial scaffold. Earlier revisions of this index listed them as "missing source gaps", which was simply wrong. They are recorded here so nobody rediscovers them and mistakes them for a specification.

| Document | Related code |
| --- | --- |
| [Kedu PRD (Draft v4)](✅-Kedu-PRD.pdf) | the `PRD §…` comments throughout `src/` |
| [Canonical Onboarding Script](✅-Kedu-Onboarding-Script.pdf) | `prisma/schema.prisma`, onboarding prompts and service |
| [Character & Tone System Prompt](✅-Kedu-Character-Tone-Prompt.pdf) | `src/ai/prompts/kedu-persona.prompts.ts` |

**Read them for background only. They are stale in places and the code is correct.** They predate the rename to Udara and the current stack — the PRD still describes n8n orchestration and calls the product Kedu. The onboarding script's stage numbering does not match the `OnboardingStage` enum that actually runs.

So, concretely:

- Do **not** change code to match a PDF.
- Do **not** rewrite a behavior doc from a PDF. [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md) describes what the code does, and that remains the correct description.
- Do use them for *why* a rule exists — the reasoning behind the spending window, the fee structure, the deliberately costly override path, the voice.
- If a PDF and the code disagree, that is a product question for a human, not a bug to fix.

The filenames begin with an emoji, which breaks `Get-ChildItem`, some glob tooling, and shell autocomplete. Use `git ls-files -- "docs/*.pdf"` or open them from the editor.

## WhatsApp Flow assets

Operational JSON for Meta Flows (never collect this data in chat):

- [whatsapp-flows/kyc-verification.json](whatsapp-flows/kyc-verification.json)
- [whatsapp-flows/pin-setup.json](whatsapp-flows/pin-setup.json)
- [whatsapp-flows/pin-entry.json](whatsapp-flows/pin-entry.json)
