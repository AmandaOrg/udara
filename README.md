# Amanda
.
A strict WhatsApp savings agent that governs a real Rubies Microfinance account. Amanda enforces a daily spending window, confirm-before-send transfers, daily/weekly allowances, and a delayed “managers” path for settings changes.

The npm package is still named `kedu`. User-facing product voice is **Amanda**.

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

---

## Testing Guide

Verification is required before any code merge. Run the appropriate test layers depending on the changes made.

### 1. Test Layers Overview

| Layer | Command | Focus & Guarantees |
| --- | --- | --- |
| **Unit Tests** | `npm test` | Jest test suite under `src/` validating business logic, allowance calculations, windows, and router paths. |
| **Golden Dialogues** | `npm run orchestrator:golden` | Evaluates dialogue turns against predefined golden conversation fixtures in `src/orchestrator/evals/golden-dialogues.json`. |
| **Smoke E2E** | `npm run e2e:smoke` | Black-box HTTP validation of critical webhook flows against a running local instance. |
| **Full E2E Scenarios** | `npm run e2e` | Comprehensive end-to-end scenarios (transfer wizards, account flows, onboarding, and auth). |
| **Docs Structure & Links** | `npm run docs:check` | Validates markdown link integrity, headings, and required architecture documents. |
| **Security Invariants** | `npm run security:check` | Scans for secret leaks, checks redaction tables, and verifies security-critical test coverage. |

### 2. Running Tests Locally

Ensure the local database container is running and environment variables use dry-run mode:

```bash
# 1. Start Postgres container
docker compose up -d

# 2. Run unit tests
npm test

# 3. Targeted test execution
npx jest src/orchestrator/action-validator.service.spec.ts

# 4. Dialogue and validator eval
npm run orchestrator:golden

# 5. Security and documentation validation
npm run security:check
npm run docs:check
```

### 3. Black-Box E2E Testing

E2E tests run against a running server process with stubbed third-party services:

```bash
# Terminal 1: Start the server with dry-run flags
WHATSAPP_DRY_RUN=true RUBIES_DRY_RUN=true AI_PROVIDER=stub npm run start:dev

# Terminal 2: Run smoke or full e2e suite
npm run e2e:smoke
npm run e2e
```

---

## Deployment Guide

### 1. Pre-Deployment Verification

Before triggering a release, ensure all CI checks pass locally:

```bash
npm run security:check
npm run docs:check
npm run lint
npm test
npm run build
```

### 2. Production Build and Start

The production lifecycle automatically runs Prisma migrations prior to booting the application:

```bash
# Compile TypeScript and generate Prisma client
npm run build

# Apply database migrations and start server (invokes scripts/start-prod.js)
npm run start:prod
```

### 3. Docker Deployment

A production-ready `Dockerfile` based on `node:20-bookworm-slim` is provided:

```bash
# Build the container image
docker build -t amanda-backend:latest .

# Run container with environment configuration
docker run -d \
  --name amanda-backend \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db?sslmode=require" \
  -e NODE_ENV="production" \
  amanda-backend:latest
```

### 4. Railway / Cloud Deployment

Amanda is configured for continuous deployment on **Railway** (see [`railway.json`](railway.json) and [`railpack.json`](railpack.json)):

- **Build Pipeline**: Uses the `RAILPACK` builder to install production dependencies and compile via `npm run build`.
- **Start Command**: Runs `node scripts/start-prod.js`, which automatically applies `prisma migrate deploy` before launching `dist/main.js`.
- **Health Checks**: Exposes HTTP health checks at `/health` on port `3000`.
- **Required Production Environment Variables**:
  - `DATABASE_URL`: Connection string to production PostgreSQL database.
  - `PORT`: Server port (defaults to `3000`).
  - `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: Meta Cloud API credentials.
  - `RUBIES_SECRET_KEY`, `RUBIES_BASE_URL`: Rubies Microfinance Bank BaaS credentials.
  - `AI_PROVIDER`: Configured AI provider (`anthropic`, `gemini`, `openrouter`, or `bedrock`).
  - `SENTRY_DSN`: Error monitoring.

