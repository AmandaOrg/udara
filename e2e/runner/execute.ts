import * as fs from 'fs';
import * as path from 'path';
import { Scenario, ScenarioContext, ScenarioSkipped } from './define';

export type ScenarioOutcome =
  | {
      name: string;
      description: string;
      status: 'pass';
      durationMs: number;
      logs: string[];
    }
  | {
      name: string;
      description: string;
      status: 'fail';
      durationMs: number;
      logs: string[];
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      name: string;
      description: string;
      status: 'skip';
      reason: string;
    };

/** Load every `*.scenario.ts` under `e2e/scenarios/` and return them. */
export function discoverScenarios(rootDir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.scenario.ts')) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(full);
      const s: Scenario | undefined = mod.default ?? mod.scenario;
      if (!s || typeof s.run !== 'function') {
        throw new Error(
          `[e2e] ${full} has no default Scenario export (got ${Object.keys(
            mod,
          ).join(',')})`,
        );
      }
      scenarios.push(s);
    }
  }
  walk(rootDir);
  scenarios.sort((a, b) => a.name.localeCompare(b.name));
  return scenarios;
}

export async function runScenario(s: Scenario): Promise<ScenarioOutcome> {
  if (s.skip) {
    return {
      name: s.name,
      description: s.description,
      status: 'skip',
      reason:
        typeof s.skip === 'object' && s.skip.reason ? s.skip.reason : 'skipped',
    };
  }

  const logs: string[] = [];
  const ctx: ScenarioContext = {
    log: (m) => logs.push(m),
  };

  const start = Date.now();
  try {
    await s.run(ctx);
    return {
      name: s.name,
      description: s.description,
      status: 'pass',
      durationMs: Date.now() - start,
      logs,
    };
  } catch (err) {
    if (err instanceof ScenarioSkipped) {
      return {
        name: s.name,
        description: s.description,
        status: 'skip',
        reason: err.message,
      };
    }

    const durationMs = Date.now() - start;
    const e = err as Error;
    return {
      name: s.name,
      description: s.description,
      status: 'fail',
      durationMs,
      logs,
      error: {
        message: e.message ?? String(err),
        stack: e.stack,
      },
    };
  }
}
