/**
 * Loads `.env` then `.env.e2e` (e2e wins). Helpers must not import from `src/`.
 */

import * as fs from 'fs';
import * as path from 'path';

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const root = path.resolve(__dirname, '..', '..');
const fromDotEnv = parseEnvFile(path.join(root, '.env'));
const fromE2e = parseEnvFile(path.join(root, '.env.e2e'));
// Empty values in .env.e2e must not blank secrets that .env (and the live
// server) still have — that desyncs unsigned/wrong-signature scenarios.
const merged: Record<string, string> = { ...fromDotEnv };
for (const [k, v] of Object.entries(fromE2e)) {
  if (v !== '') merged[k] = v;
}

for (const [k, v] of Object.entries(merged)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

export const e2eEnv = {
  baseUrl: (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000').replace(
    /\/$/,
    '',
  ),
  databaseUrl:
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://kedu:kedu@localhost:5433/kedu?schema=public',
  verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '',
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET ?? '',
  rubiesSecretKey: process.env.RUBIES_SECRET_KEY ?? '',
  orchestratorLive: process.env.E2E_ORCHESTRATOR_LIVE === '1',
  rubiesWebhookPath:
    process.env.E2E_RUBIES_WEBHOOK_PATH ?? '/rubies/webhooks',
};

export function requireServerReachableHint(): string {
  return `Is the Nest app running at ${e2eEnv.baseUrl}? Start with WHATSAPP_DRY_RUN=true RUBIES_DRY_RUN=true npm run start:dev`;
}
