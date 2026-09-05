/**
 * The operator half of "the managers" (ADR-0001).
 *
 * A user can now file a settings-change request from chat, and the seven-day
 * gate starts ticking from that moment. Somebody still has to decide it, and
 * until this existed the only way was editing the database by hand.
 *
 * Deliberately a CLI rather than an HTTP route. This app has no admin identity
 * model, and the first thing such a route would do is lift someone's spending
 * restrictions — inventing authentication for that is a bigger decision than
 * the one ADR-0001 makes. Whoever can run this already holds the database
 * credentials, so it grants no new authority.
 *
 *   npm run settings:list
 *   npm run settings:decide -- --id <requestId> --approve --notes "..."
 *   npm run settings:decide -- --id <requestId> --reject  --notes "..."
 *
 * The eligibility gate is not bypassable from here: ManagerService refuses any
 * decision before eligibleAt, whoever is asking.
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
loadEnv();

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";
import { ManagerConversationService } from "../manager/manager-conversation.service";
import { SettingsChangeStatus } from "@prisma/client";

type Args = {
  command: "list" | "decide";
  id?: string;
  decision?: "APPROVED" | "REJECTED";
  notes?: string;
};

function parseArgs(argv: string[]): Args {
  const command = argv.includes("--decide") ? "decide" : "list";
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    command,
    id: at("--id"),
    decision: argv.includes("--approve")
      ? "APPROVED"
      : argv.includes("--reject")
        ? "REJECTED"
        : undefined,
    notes: at("--notes"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Boots AppModule to reach its providers, which would otherwise start every
  // cron and make this machine a second replica against production.
  process.env.DISABLE_SCHEDULERS = "true";

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const prisma = app.get(PrismaService);

    if (args.command === "list") {
      const open = await prisma.settingsChangeRequest.findMany({
        where: {
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        orderBy: { requestedAt: "asc" },
        include: { user: { select: { whatsappNumber: true, name: true } } },
      });

      if (open.length === 0) {
        console.log("No open settings-change requests.");
        return;
      }

      const now = new Date();
      for (const r of open) {
        const eligible = r.eligibleAt <= now;
        console.log(
          [
            r.id,
            r.type.padEnd(18),
            eligible
              ? "ELIGIBLE NOW"
              : `eligible ${r.eligibleAt.toDateString()}`,
            `${r.user.name ?? "unnamed"} (${r.user.whatsappNumber})`,
            JSON.stringify(r.requestedChange),
            r.reason ? `reason: ${JSON.stringify(r.reason)}` : "",
          ].join("  "),
        );
      }
      console.log(`\n${open.length} open request(s).`);
      return;
    }

    if (!args.id || !args.decision) {
      console.error(
        "Usage: --decide --id <requestId> (--approve | --reject) [--notes '...']",
      );
      process.exitCode = 1;
      return;
    }

    const managers = app.get(ManagerConversationService);
    const updated = await managers.reviewRequest(
      args.id,
      args.decision,
      args.notes,
    );
    console.log(
      `Request ${updated.id} is now ${updated.status}. The user has been told.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
