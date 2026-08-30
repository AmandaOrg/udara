/**
 * Windows-friendly wrapper:
 *   npm run orchestrator:fixture -- ./src/cli/sample-fixture.json "send 5k to landlord"
 *
 * Positional args survive npm better than --fixture / --message flags on PowerShell.
 */

import { spawnSync } from "child_process";
import * as path from "path";

const fixture = process.argv[2] ?? path.join(__dirname, "sample-fixture.json");
const message =
  process.argv.length > 3
    ? process.argv.slice(3).join(" ")
    : "send 5k to my landlord";

const cli = path.join(__dirname, "orchestrator-cli.ts");
const result = spawnSync(
  process.execPath,
  [
    require.resolve("ts-node/dist/bin.js"),
    "-r",
    "tsconfig-paths/register",
    cli,
    "--fixture",
    fixture,
    "--message",
    message,
  ],
  { stdio: "inherit", shell: false },
);

process.exit(result.status ?? 1);
