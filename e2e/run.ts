#!/usr/bin/env node
/**
 * Entry point for the Udara e2e runner (BrandDrive-style).
 *
 * Usage:
 *   npm run e2e
 *   npm run e2e transfer
 *   npm run e2e:smoke
 *   npx ts-node --project e2e/tsconfig.json e2e/run.ts --tag hack --bail
 */

import './helpers/env';
import * as path from 'path';
import { discoverScenarios, runScenario } from './runner/execute';
import { printJsonReport, printTextReport } from './runner/report';
import { disconnectPrisma } from './helpers/db';

function parseArgs(argv: string[]): {
  filters: string[];
  tag?: string;
  json: boolean;
  bail: boolean;
} {
  const filters: string[] = [];
  let tag: string | undefined;
  let json = false;
  let bail = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--bail') bail = true;
    else if (a === '--tag') tag = argv[++i];
    else if (a.startsWith('--tag=')) tag = a.slice('--tag='.length);
    else if (a.startsWith('--')) {
      console.error(`[e2e] unknown flag: ${a}`);
      process.exit(2);
    } else {
      filters.push(a);
    }
  }
  return { filters, tag, json, bail };
}

async function main() {
  const { filters, tag, json, bail } = parseArgs(process.argv.slice(2));
  const scenarios = discoverScenarios(path.join(__dirname, 'scenarios'));

  const selected = scenarios.filter((s) => {
    if (filters.length && !filters.some((f) => s.name.startsWith(f))) {
      return false;
    }
    if (tag && !(s.tags ?? []).includes(tag)) return false;
    return true;
  });

  if (!selected.length) {
    if (json) {
      console.log(
        JSON.stringify({
          summary: { pass: 0, fail: 0, skip: 0, total: 0 },
          scenarios: [],
        }),
      );
    } else {
      console.log('[e2e] no scenarios matched the filter.');
    }
    process.exit(0);
  }

  if (!json) {
    console.log(
      `[e2e] running ${selected.length} scenario${
        selected.length === 1 ? '' : 's'
      }${filters.length ? ` (filter=${filters.join(',')})` : ''}${
        tag ? ` (tag=${tag})` : ''
      }`,
    );
    console.log('');
  }

  const outcomes: Awaited<ReturnType<typeof runScenario>>[] = [];
  for (const s of selected) {
    const o = await runScenario(s);
    outcomes.push(o);
    if (bail && o.status === 'fail') break;
  }

  if (json) {
    printJsonReport(outcomes);
  } else {
    printTextReport(outcomes);
  }

  await disconnectPrisma();

  const anyFailed = outcomes.some((o) => o.status === 'fail');
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[e2e] runner crashed:', err);
  await disconnectPrisma().catch(() => undefined);
  process.exit(2);
});
