# Development

## Prerequisites

- Node 20 (CI uses 20)
- Docker (Postgres 16)
- npm

## First run

```bash
npm install
docker compose up -d
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

Postgres is on host port **5433**, not 5432. `DATABASE_URL` in `.env.example` matches.

## Environment

Boot-time structural checks live in [`src/config/env.validation.ts`](../src/config/env.validation.ts). Secrets for WhatsApp, Rubies, and AI are optional at boot so local/stub mode can start; the services that need them fail clearly on first real call.

Canonical catalog: [`.env.example`](../.env.example). Do not commit `.env` or `.env.e2e`.

Recommended local values:

```
WHATSAPP_DRY_RUN=true
RUBIES_DRY_RUN=true
AI_PROVIDER=stub
WHATSAPP_WEBHOOK_VERIFY_TOKEN=e2e-verify-token
```

Leave `WHATSAPP_APP_SECRET` and `RUBIES_SECRET_KEY` blank only for unsigned local acceptance. Set them before pointing a real number or production Rubies webhooks at this process.

## Migrations

Schema changes go through Prisma:

```bash
npx prisma migrate dev --name <slug>
npx prisma migrate deploy   # CI and shared DBs
```

Never edit applied SQL in place. Update [ARCHITECTURE.md](ARCHITECTURE.md) and `.cursor/project/summary.md` when models or enums change.

## Scripts

See root [README.md](../README.md). Format with `npm run format`; lint with `npm run lint`.

## Conventions

- Co-locate unit tests as `*.spec.ts` next to the unit.
- Prefer double quotes in `src/` (existing style); orchestrator files currently mix quotes — match the file you edit.
- Comment **why** (invariants, PRD reconstruction, workarounds), not what.
- `forwardRef` only for the documented WhatsApp circulars.
- Do not put KYC or PIN values in chat payloads or logs.

## Windows notes

PowerShell may drop flags after `npm run e2e`. If so, call ts-node as in [e2e/README.md](../e2e/README.md).
