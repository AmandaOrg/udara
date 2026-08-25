# E2E test suite — real HTTP against the running app

BrandDrive-style black-box scenarios for Udara. Every scenario is a self-contained TypeScript file that:

1. POSTs a Meta-shaped WhatsApp webhook (or hits verify / Rubies webhooks).
2. Asserts HTTP status immediately (controller acks `200` before processing).
3. Asserts side effects via Postgres (`WhatsappMessage` outbound rows, `User`, `TransferDraft`, …).

**No Nest TestingModule. No imports from `src/` in helpers.** The goal is raising confidence that inbound routing, wizards, and guards still work after a change.

---

## Prerequisites

1. Postgres up: `docker compose up -d`
2. Migrations applied: `npx prisma migrate deploy`
3. Copy env for the **runner**: `copy e2e\.env.e2e.example .env.e2e` (and fill `WHATSAPP_WEBHOOK_VERIFY_TOKEN` to match the server)
4. Start the **server** with dry-runs (critical — otherwise Meta Graph sends fail and no outbound rows appear):

```bash
# In .env / process env for start:dev:
WHATSAPP_DRY_RUN=true
RUBIES_DRY_RUN=true
AI_PROVIDER=stub
WHATSAPP_WEBHOOK_VERIFY_TOKEN=e2e-verify-token
# Leave WHATSAPP_APP_SECRET and RUBIES_SECRET_KEY blank for local unsigned acceptance

npm run start:dev
```

5. In another terminal: `npm run e2e:smoke`

---

## Contract (Udara-flavored)

For every non-trivial change, run the relevant subset before declaring done. New features should ship with new `*.scenario.ts` files.

Assert where applicable:

1. Happy path (webhook ack + expected outbound / DB state)
2. Signature / auth bypass (unsigned local vs wrong HMAC when secret set)
3. Idempotency (`waMessageId` redelivery → single inbound row)
4. Malformed payloads do not crash the process (follow-up webhook still 200)
5. No raw KYC/PIN in persisted message bodies where redaction applies

---

## Layout

```
e2e/
  README.md
  .env.e2e.example
  run.ts
  tsconfig.json
  runner/          # define / execute / report
  helpers/         # env, http, assert, whatsapp, db, fixtures, ids
  scenarios/
    webhook/
    inbound/
    transfer/
    orchestrator/
    onboarding/
    rubies/
    security/
```

---

## Running

```bash
npm run e2e              # all scenarios
npm run e2e:smoke        # --tag smoke
npm run e2e transfer     # name prefix filter
npm run e2e -- --tag hack
npm run e2e -- --bail
npm run e2e -- --json    # machine-readable for agents
```

On Windows PowerShell, if flags get dropped, call ts-node directly:

```bash
npx ts-node --project e2e/tsconfig.json e2e/run.ts --tag smoke
```

---

## Orchestrator notes

- Default `AI_PROVIDER=stub` does not emit `propose_turn` tool calls → free text hits failure SOP (apology + menu). Covered by `orchestrator.stub.failure-sop`.
- Deterministic money/menu paths use exact keywords (`balance`, `menu`, `transfer`) — preferred for CI smoke.
- Opt-in live LLM: set `E2E_ORCHESTRATOR_LIVE=1` and a real `AI_PROVIDER` on the server, then run `orchestrator.live.free-text-reply`.

---

## Authoring a scenario

```ts
import { defineScenario } from '../../runner/define';

export default defineScenario({
  name: 'transfer.wizard.example',
  description: 'One sentence for humans and agents',
  tags: ['flow', 'transfer'],
  async run(ctx) {
    ctx.log('step…');
    // post webhook → waitForOutbound / getActiveDraft → assert
  },
});
```

Soft-skip when a fixture/flag is missing:

```ts
import { ScenarioSkipped } from '../../runner/define';
throw new ScenarioSkipped('reason');
```
