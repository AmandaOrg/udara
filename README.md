# Udara

A strict WhatsApp savings agent that governs a real Rubies Microfinance account. Udara enforces a daily spending window, confirm-before-send transfers, daily/weekly allowances, and a delayed “managers” path for settings changes.

The npm package is still named `kedu`. User-facing product voice is **Udara**.

## Start here

| Audience | Read |
| --- | --- |
| Humans (setup + map) | this file, then [docs/README.md](docs/README.md) |
| Collaborators and AI agents | [AGENTS.md](AGENTS.md) |
| Anyone changing money, PII, or prompts | [docs/SECURITY.md](docs/SECURITY.md) — mandatory |
| Active work | [initiatives/README.md](initiatives/README.md) |

## Stack

NestJS 10, Prisma 5, PostgreSQL 16, TypeScript, Jest unit tests, black-box HTTP e2e, golden orchestrator dialogues.

Default HTTP port **3000**. Local Postgres is published on host **5433** (see [docker-compose.yml](docker-compose.yml)).

## Local setup

```bash
npm install
docker compose up -d
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

For local and e2e runs, keep dry-run flags on:

- `WHATSAPP_DRY_RUN=true`
- `RUBIES_DRY_RUN=true`
- `AI_PROVIDER=stub`

Details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [.env.example](.env.example).

## Modules

```
src/
  prisma/        Global PrismaService
  config/        Boot-time env validation
  allowance/     Window, fees, daily/weekly allowance
  onboarding/    Stage machine + ConversationSession
  tagging/       Recipient tags
  manager/       Settings-change gate + delayed persona
  rubies/        BaaS client + inbound webhook
  ai/            LLM providers (stub / anthropic / openrouter / gemini / bedrock)
  orchestrator/  propose_turn brain + validator + surfaces (no WhatsApp send)
  whatsapp/      Webhook, router, wizards, PIN gate, ActionExecutor
  pin/           PIN challenge / verify
  cli/           Orchestrator dry-run + golden runner
  common/        WAT time, bank match, display name
```

## Commands

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch-mode Nest server (local) |
| `npm start` / `start:prod` | Production: migrate, then `dist/main.js` |
| `npm run build` | `nest build` |
| `npm test` | Jest unit tests under `src/` |
| `npm run lint` | ESLint |
| `npm run e2e` / `npm run e2e:smoke` | Black-box HTTP scenarios |
| `npm run orchestrator:golden` | Golden dialogue validator |
| `npm run orchestrator:cli` | Safe orchestrator dry-run REPL |
| `npm run docs:check` | Documentation structure and link check |
| `npm run security:check` | Security invariants, secret scan, redaction sync |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `security:check`, `docs:check`, lint, Prisma generate/migrate, build, and unit tests. E2e and live LLM evals stay local.

## Documentation system

Non-trivial work uses three layers:

1. **Initiative plan** — execution status in `initiatives/<name>/plan.md`
2. **Spec** — stakeholder-visible behavior in `docs/specs/`
3. **Tech design** — implementation in `docs/tech-design/`

Cross-cutting maps live in [docs/PRODUCT_BEHAVIOR.md](docs/PRODUCT_BEHAVIOR.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/TESTING.md](docs/TESTING.md).
