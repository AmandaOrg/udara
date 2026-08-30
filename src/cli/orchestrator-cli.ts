/**
 * Safe orchestrator dry-run CLI.
 *
 *   npm run orchestrator:cli
 *   npm run orchestrator:cli -- --message "send 5k to my landlord"
 *   npm run orchestrator:cli -- --fixture ./path.json --message "..."
 *   npm run orchestrator:cli -- --golden
 *
 * Never boots WhatsApp / Rubies / ActionExecutor. Print-only.
 */

import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { NestFactory } from "@nestjs/core";
import { OnboardingStage } from "@prisma/client";
import { CliOrchestratorModule } from "./cli-orchestrator.module";
import { FixtureLlmService } from "./fixture-llm.service";
import { CliNoopLlmLogger } from "./cli-noop-llm-logger";
import { printTurn } from "./print-executor";
import { runAllGoldenCases } from "./golden-runner";
import { OrchestratorService } from "../orchestrator/orchestrator.service";
import { ProposedTurn } from "../orchestrator/orchestrator.types";
import { getEligibleSurfaces } from "../orchestrator/surface-registry";

type CliArgs = {
  message?: string;
  fixture?: string;
  golden: boolean;
  noAccount: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    golden: false,
    noAccount: false,
    json: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--golden") args.golden = true;
    else if (a === "--no-account") args.noAccount = true;
    else if (a === "--json") args.json = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--message" || a === "-m") {
      args.message = argv[++i];
    } else if (a === "--fixture" || a === "-f") {
      args.fixture = argv[++i];
    } else if (a.startsWith("--message=")) {
      args.message = a.slice("--message=".length);
    } else if (a.startsWith("--fixture=")) {
      args.fixture = a.slice("--fixture=".length);
    }
  }

  // Env fallbacks — Windows npm/PowerShell often drops flags after `npm run`.
  if (process.env.ORCHESTRATOR_GOLDEN === "1") args.golden = true;
  if (process.env.ORCHESTRATOR_MESSAGE)
    args.message = process.env.ORCHESTRATOR_MESSAGE;
  if (process.env.ORCHESTRATOR_FIXTURE)
    args.fixture = process.env.ORCHESTRATOR_FIXTURE;
  if (process.env.ORCHESTRATOR_NO_ACCOUNT === "1") args.noAccount = true;
  if (process.env.ORCHESTRATOR_JSON === "1") args.json = true;
  if (process.env.ORCHESTRATOR_VERBOSE === "1") args.verbose = true;

  return args;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Udara orchestrator dry-run CLI

  npm run orchestrator:cli
  npm run orchestrator:golden
  npm run orchestrator:fixture -- ./src/cli/sample-fixture.json "send 5k"

  # Or call ts-node directly (most reliable on Windows):
  npx ts-node -r tsconfig-paths/register src/cli/orchestrator-cli.ts --golden
  npx ts-node -r tsconfig-paths/register src/cli/orchestrator-cli.ts --fixture ./src/cli/sample-fixture.json --message "send 5k"

Flags:
  --message, -m   One-shot user message (then exit)
  --fixture, -f   JSON file with a ProposedTurn / mock_proposal (forces tool call)
  --golden        Replay golden-dialogues.json through the validator (no LLM)
  --no-account    Simulate user without Rubies account (prunes surfaces)
  --json          Machine-readable turn output
  --verbose       Log LLM audit stubs to stderr
  --help          Show this help

Env fallbacks (useful when npm drops flags on Windows):
  ORCHESTRATOR_GOLDEN=1
  ORCHESTRATOR_MESSAGE="..."
  ORCHESTRATOR_FIXTURE=./src/cli/sample-fixture.json
  ORCHESTRATOR_NO_ACCOUNT=1
  ORCHESTRATOR_JSON=1

DRY-RUN — no WhatsApp, no Rubies, no transfers.
`);
}

function printBanner() {
  // eslint-disable-next-line no-console
  console.error("DRY-RUN — no WhatsApp, no Rubies, no transfers");
}

function makeUser(noAccount: boolean) {
  return {
    id: "cli-user-1",
    whatsappNumber: "2348000000001",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: noAccount ? null : "0123456789",
    rubiesAccountName: noAccount ? null : "CLI Test User",
    name: "CLI",
    windowStartHour: 11,
    windowEndHour: 20,
    disciplineExitedAt: null,
  } as any;
}

function loadFixtureFile(filePath: string): ProposedTurn {
  const abs = path.resolve(filePath);
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  // Accept either a bare ProposedTurn or a golden case with mock_proposal
  const proposal = raw.mock_proposal ?? raw;
  if (!proposal?.message || !proposal?.action?.type) {
    throw new Error(
      `Fixture ${abs} must be a ProposedTurn ({ message, action }) or golden case with mock_proposal`,
    );
  }
  return proposal as ProposedTurn;
}

async function runGolden(asJson: boolean): Promise<number> {
  const results = runAllGoldenCases();
  const failed = results.filter((r) => !r.passed);

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        { total: results.length, failed: failed.length, results },
        null,
        2,
      ),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`Golden validator replay — ${results.length} cases\n`);
    for (const r of results) {
      const mark = r.passed ? "PASS" : "FAIL";
      // eslint-disable-next-line no-console
      console.log(
        `  [${mark}] ${r.test_case_id}  expected=${JSON.stringify(r.expected_surface)} actual=${JSON.stringify(r.actual_surface)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n${results.length - failed.length} passed, ${failed.length} failed`,
    );
  }

  return failed.length > 0 ? 1 : 0;
}

async function runOrchestratorSession(args: CliArgs): Promise<number> {
  const useFixture = !!args.fixture;
  const app = await NestFactory.createApplicationContext(
    CliOrchestratorModule.forRoot({ useFixtureLlm: useFixture }),
    { logger: args.verbose ? ["error", "warn", "log", "debug"] : ["error"] },
  );

  try {
    const logger = app.get(CliNoopLlmLogger);
    logger.setVerbose(args.verbose);

    if (useFixture) {
      const fixtureLlm = app.get(FixtureLlmService);
      fixtureLlm.setFixture(loadFixtureFile(args.fixture!));
    }

    const orchestrator = app.get(OrchestratorService);
    const user = makeUser(args.noAccount);

    // eslint-disable-next-line no-console
    console.error(
      `User: account=${user.rubiesAccountNumber ? "yes" : "no"}  eligible surfaces: ${getEligibleSurfaces(
        user,
      )
        .map((s) => s.key)
        .join(", ")}`,
    );
    if (!useFixture && (process.env.AI_PROVIDER ?? "stub") === "stub") {
      // eslint-disable-next-line no-console
      console.error(
        "AI_PROVIDER=stub — expect ok:false unless you pass --fixture or set a real provider.",
      );
    }

    const runOnce = async (text: string) => {
      const result = await orchestrator.handleMessage(user, text);
      printTurn(result, args.json);
    };

    if (args.message !== undefined) {
      await runOnce(args.message);
      return 0;
    }

    // Interactive REPL
    // eslint-disable-next-line no-console
    console.error('Interactive mode — type a message, or "quit" to exit.\n');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): Promise<void> =>
      new Promise((resolve) => {
        rl.question("you> ", async (line) => {
          const text = line.trim();
          if (!text || text === "quit" || text === "exit") {
            rl.close();
            resolve();
            return;
          }
          try {
            await runOnce(text);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("Error:", err);
          }
          // eslint-disable-next-line no-console
          console.log("");
          await prompt();
          resolve();
        });
      });

    await prompt();
    return 0;
  } finally {
    await app.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  printBanner();

  if (args.golden) {
    process.exit(await runGolden(args.json));
  }

  process.exit(await runOrchestratorSession(args));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
