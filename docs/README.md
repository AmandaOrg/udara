# Documentation index

Canonical home for Udara knowledge that should survive a chat session. Code comments explain *why a line exists*. These files explain *what the product does*, *how the system is shaped*, and *what is in flight*.

## Ownership map

| Kind | Path | Owner of truth | Update when |
| --- | --- | --- | --- |
| Product behavior (verified) | [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md) | Code + this file | Discipline rules, routing, or safety boundaries change |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) | Nest modules + Prisma | Module graph, request flow, or integrations change |
| Development | [DEVELOPMENT.md](DEVELOPMENT.md) | `.env.example` + scripts | Setup, env, or local workflow change |
| Testing | [TESTING.md](TESTING.md) | Jest / e2e / golden runner | Test contract or verification matrix change |
| Feature specs | [specs/](specs/README.md) | Spec + matching tests | Observable behavior changes |
| Tech designs | [tech-design/](tech-design/README.md) | Code | Implementation shape changes |
| Decisions | [decisions/](decisions/README.md) | The ADR | A cross-cutting choice is locked |
| Initiatives | [../initiatives/README.md](../initiatives/README.md) | `plan.md` | Status or scope of work changes |
| WhatsApp Flows | [whatsapp-flows/](whatsapp-flows/) | Meta-published Flow JSON | KYC/PIN forms change |
| Agent contract | [../AGENTS.md](../AGENTS.md) | Collaborators | Working rules change |

## How to use this tree

1. Read [../AGENTS.md](../AGENTS.md) before editing.
2. For behavior questions, start at [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md), then the matching spec.
3. For “where does this live?”, start at [ARCHITECTURE.md](ARCHITECTURE.md) or `.cursor/project/summary.md`.
4. For in-progress work, start at [../initiatives/README.md](../initiatives/README.md).
5. Do not invent missing source documents. List them as gaps.

## Source gaps

These are cited in code but **not committed** in this repository:

| Citation | Referenced from | Status |
| --- | --- | --- |
| Original PRD | Many `src/` comments (`PRD §…`) | Unresolved. Verified behavior is reconstructed from code and tests. |
| `docs/Udara-Onboarding-Script` | `prisma/schema.prisma`, onboarding prompts/service | Unresolved. Stage enum in Prisma is the committed sequence. |
| `docs/✅-Kedu-Character-Tone-Prompt.pdf` | `src/ai/prompts/kedu-persona.prompts.ts` | Unresolved. Persona text in that file is the committed voice. |

Until those files are added, treat **code + tests + this docs tree** as the source of truth, and keep the table above honest.

## WhatsApp Flow assets

Operational JSON for Meta Flows (never collect this data in chat):

- [whatsapp-flows/kyc-verification.json](whatsapp-flows/kyc-verification.json)
- [whatsapp-flows/pin-setup.json](whatsapp-flows/pin-setup.json)
- [whatsapp-flows/pin-entry.json](whatsapp-flows/pin-entry.json)
