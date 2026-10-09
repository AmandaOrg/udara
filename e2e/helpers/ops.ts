/**
 * Runs an ops CLI from src/cli the way an operator would, against the e2e
 * database and nothing else.
 *
 * The CLIs load .env, which may point at a hosted database, so the database
 * URL is passed explicitly and must be local: an e2e scenario that closes
 * accounts must never be able to reach a real one.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { e2eEnv } from "./env";

const ROOT = path.resolve(__dirname, "..", "..");
const TIMEOUT_MS = 10 * 60_000;

/**
 * Uses the build in dist/ when there is one: the e2e server runs from dist, so
 * that is the code under test, and it starts in seconds where ts-node takes a
 * minute. Otherwise the source through ts-node, as `npm run` does.
 *
 * Asynchronous on purpose. spawnSync blocks the runner's event loop for the
 * whole run, so the HTTP client cannot notice the server closing an idle
 * keep-alive connection, and the next request goes out on a dead socket.
 */
export function runOpsCli(
  script: string,
  args: string[],
): Promise<{ status: number | null; output: string }> {
  const databaseUrl = e2eEnv.databaseUrl;
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) {
    throw new Error(
      "runOpsCli: refusing to run an ops CLI against a database that is not local. Set E2E_DATABASE_URL to the docker Postgres.",
    );
  }

  const built = path.join(
    ROOT,
    "dist",
    "src",
    "cli",
    script.replace(/\.ts$/, ".js"),
  );
  const command = fs.existsSync(built)
    ? [built, ...args]
    : [
        require.resolve("ts-node/dist/bin.js"),
        "-r",
        "tsconfig-paths/register",
        path.join("src", "cli", script),
        ...args,
      ];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, command, {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TS_NODE_PROJECT: path.join(ROOT, "tsconfig.json"),
        TS_NODE_TRANSPILE_ONLY: "true",
        // Everything that could reach a real service is off.
        RUBIES_DRY_RUN: "true",
        WHATSAPP_DRY_RUN: "true",
        SMS_DRY_RUN: "true",
        PUSH_DRY_RUN: "true",
        AI_PROVIDER: "stub",
        DISABLE_SCHEDULERS: "true",
        SENTRY_DSN: "",
        RESEND_API_KEY: "",
        DEEPGRAM_API_KEY: "",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const timer = setTimeout(() => {
      output += `\nrunOpsCli: killed after ${TIMEOUT_MS / 60_000} minutes`;
      child.kill();
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, output: `${output}${String(err)}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}
