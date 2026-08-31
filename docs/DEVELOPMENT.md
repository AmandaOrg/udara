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

Inbound voice notes need `DEEPGRAM_API_KEY` on the **same process that receives the WhatsApp webhook** (local `.env` does not apply to Railway). Optional `DEEPGRAM_STT_MODEL` defaults to `nova-3`. Without the key, Udara asks the user to type. `WHATSAPP_DRY_RUN=true` still skips outbound Graph sends; inbound media download still runs so voice and photos can be understood.

## Migrations

Schema changes go through Prisma:

```bash
npx prisma migrate dev --name <slug>
npx prisma migrate deploy   # CI, and also every production boot
```

Production boot is `node scripts/start-prod.js`: `prisma migrate deploy`, then `node dist/main.js`. If `dist/` is missing it compiles once. Do **not** put migrate inside `npm run build`.

## Production (Railway)

This service uses **Railpack** (the dashboard default). Leave **Build command empty**. Railpack already runs `npm ci`, then `npm run build` (`prisma generate && nest build`).

Do **not** add a custom Build command that includes `npm ci` or `npm install`. Railpack mounts `node_modules/.cache`; a second install tries to delete that mount and fails with `EBUSY rmdir node_modules/.cache`.

Start is `node scripts/start-prod.js` (also `npm start` / `Procfile` / `railpack.json`). That applies pending Prisma migrations, then runs `dist/main.js`.

The root `Dockerfile` is unused while the Builder dropdown is Railpack. Do not switch builders unless you intend to.

Keep `WHATSAPP_DRY_RUN` unset or `false`. Local development is `npm run start:dev`, not `npm start`.

Never edit applied SQL in place. Update [ARCHITECTURE.md](ARCHITECTURE.md) and `.cursor/project/summary.md` when models or enums change.

## Scripts

See root [README.md](../README.md). Format with `npm run format`; lint with `npm run lint`.

**`npm run lint` rewrites files.** It runs `eslint --fix` with the Prettier plugin, so it is a formatter, not a check. To check your own work without touching the tree, run `npx eslint <the files you touched>`.

[`.gitattributes`](../.gitattributes) pins the working tree to LF on every platform. Without it a Windows checkout gets CRLF, Prettier flags every line, and `--fix` rewrites all 200+ files into an unreviewable diff — which is exactly the kind of diff a weakened guard can hide inside. Do not remove it.

A repo-wide `npx eslint` still reports roughly 800 `prettier/prettier` findings. Those are real, pre-existing quote-style inconsistencies (parts of `src/orchestrator/` and `src/cli/` use single quotes), not line endings. Match the file you are editing rather than reformatting it; normalizing the whole tree should be its own commit.

Security and documentation gates:

```bash
npm run security:check   # S1-S12 invariants, secret scan, redaction sync
npm run docs:check       # docs structure and links
```

Both run in CI before lint. See [SECURITY.md](SECURITY.md).

## Conventions

- Co-locate unit tests as `*.spec.ts` next to the unit.
- Prefer double quotes in `src/` (existing style); orchestrator files currently mix quotes — match the file you edit.
- Comment **why** (invariants, PRD reconstruction, workarounds), not what.
- `forwardRef` only for the documented WhatsApp circulars.
- Do not put KYC or PIN values in chat payloads or logs.

## Windows notes

PowerShell may drop flags after `npm run e2e`. If so, call ts-node as in [e2e/README.md](../e2e/README.md).
