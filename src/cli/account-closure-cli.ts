/**
 * The operator half of closing an account (ADR-0003).
 *
 *   npm run account:request  -- --user <userId> [--reason "..."]
 *   npm run account:close    -- --id <requestId>              (dry run)
 *   npm run account:close    -- --id <requestId> --confirm [--residual-handled] [--notes "..."]
 *   npm run account:decline  -- --id <requestId> --notes "why it cannot be closed yet"
 *   npm run account:withdraw -- --id <requestId>
 *
 * `request` files a closure for someone who asked in chat or by email, once
 * you have confirmed it is them (the request came from the account's own
 * WhatsApp number or email address). The seven days in which they can
 * withdraw it start then.
 *
 * `close` without --confirm only reports: what stands in the way, and how
 * many rows will be kept and erased. With --confirm it closes the account and
 * cannot be undone. --residual-handled skips only the balance check, for an
 * amount you have already arranged with Rubies. Closure must be done within
 * 30 days of the request; `npm run settings:list` shows when each is due.
 *
 * Like settings:decide, a CLI rather than a route: there is no admin identity
 * in this codebase, and whoever can run this already holds the database.
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
loadEnv();

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import {
  AccountClosureService,
  ClosureRefusedError,
} from "../account-closure/account-closure.service";

type Command = "request" | "close" | "decline" | "withdraw";

function parseArgs(argv: string[]) {
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    command: argv[0] as Command,
    id: at("--id"),
    user: at("--user"),
    reason: at("--reason"),
    notes: at("--notes"),
    confirm: argv.includes("--confirm"),
    residualHandled: argv.includes("--residual-handled"),
  };
}

const USAGE = `Usage:
  account-closure-cli request  --user <userId> [--reason "..."]
  account-closure-cli close    --id <requestId> [--confirm] [--residual-handled] [--notes "..."]
  account-closure-cli decline  --id <requestId> --notes "..."
  account-closure-cli withdraw --id <requestId>`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["request", "close", "decline", "withdraw"].includes(args.command)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Boots AppModule to reach its providers, which would otherwise start every
  // cron and make this machine a second replica against production.
  process.env.DISABLE_SCHEDULERS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const closure = app.get(AccountClosureService);

    if (args.command === "request") {
      if (!args.user) throw new Error(USAGE);
      const result = await closure.request(args.user, {
        via: "ops",
        reason: args.reason,
      });
      if (result.kind === "blocked") {
        console.error(
          `Not filed: ${result.blocker}${result.balance !== null ? ` (balance ₦${result.balance})` : ""}${result.openRequest ? `, open request ${result.openRequest.id}` : ""}.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `Filed closure request ${result.request.id}. It can be closed from ${result.request.eligibleAt.toISOString()} and must be done by ${result.completeBy.toISOString()}. The user has been told.`,
      );
      return;
    }

    if (!args.id) throw new Error(USAGE);

    if (args.command === "withdraw") {
      const result = await closure.withdraw(args.id);
      if (!result.ok) {
        console.error(`Not withdrawn: ${result.reason}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Request ${args.id} withdrawn.`);
      return;
    }

    if (args.command === "decline") {
      if (!args.notes) {
        throw new Error("decline needs --notes: the user is told why.");
      }
      await closure.decline(args.id, args.notes);
      console.log(`Request ${args.id} declined. The user has been told why.`);
      return;
    }

    if (!args.confirm) {
      const plan = await closure.plan(args.id);
      console.log(
        `Dry run for closure request ${plan.requestId}, user ${plan.userId}.`,
      );
      console.log(
        plan.recordsKept
          ? "Account holder: identity, payment records and the conversation are kept for six years; the rest is erased."
          : "Never opened an account: everything is erased.",
      );
      console.log(
        plan.blockers.length === 0
          ? "Nothing stands in the way."
          : `In the way: ${plan.blockers.join(", ")}${plan.balance !== null ? ` (balance ₦${plan.balance})` : ""}.`,
      );
      for (const [table, { rows, action }] of Object.entries(plan.rows)) {
        console.log(
          `  ${table.padEnd(24)} ${String(rows).padStart(6)}  ${action}`,
        );
      }
      console.log(
        "\nRun again with --confirm to close. This cannot be undone.",
      );
      return;
    }

    const result = await closure.close(args.id, {
      residualHandled: args.residualHandled,
      notes: args.notes,
    });
    console.log(
      `Closed the account of user ${result.userId}. The user has been told.`,
    );
    console.log(
      result.recordsKeptUntil
        ? `Records are kept until ${result.recordsKeptUntil.toISOString().slice(0, 10)}.`
        : "Nothing about them was kept.",
    );
    for (const [what, rows] of Object.entries(result.erased)) {
      if (rows > 0) console.log(`  erased ${what}: ${rows}`);
    }
    if (result.rubies) {
      console.log(
        `\nNext: ask Rubies to close account ${result.rubies.accountNumber} (${result.rubies.accountName ?? "no name on file"}, customer ${result.rubies.customerId ?? "unknown"}). A credit to it from now on alerts in Sentry and messages no one.`,
      );
    }
  } catch (err) {
    if (err instanceof ClosureRefusedError) {
      console.error(`Refused (${err.reason}): ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
