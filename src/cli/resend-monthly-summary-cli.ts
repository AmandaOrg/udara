/**
 * One-off ops CLI: resend the corrected previous-month recap to all active users.
 *
 *   npm run email:resend-monthly -- --dry-run
 *   npm run email:resend-monthly -- --dedupe-suffix corrected-aug-2026
 *
 * Requires RESEND_API_KEY in .env. Uses a dedupe suffix so users who already
 * received the wrong Sep-1 email can get the corrected August recap once.
 */

import "reflect-metadata";
import { config as loadEnv } from "dotenv";
loadEnv();
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";
import { EmailNotificationsService } from "../email/email-notifications.service";
import {
  formatPreviousWatMonthLabel,
  startOfWatMonthInstant,
  watDateBucketKey,
} from "../common/wat-time.util";

function dateKey(date: Date): string {
  return watDateBucketKey(date).toISOString().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  let dedupeSuffix = "corrected";
  let userId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dedupe-suffix" && argv[i + 1]) {
      dedupeSuffix = argv[++i];
    } else if (a.startsWith("--dedupe-suffix=")) {
      dedupeSuffix = a.slice("--dedupe-suffix=".length);
    } else if (a === "--user-id" && argv[i + 1]) {
      userId = argv[++i];
    } else if (a.startsWith("--user-id=")) {
      userId = a.slice("--user-id=".length);
    }
  }
  return { dryRun, dedupeSuffix, userId };
}

async function main() {
  const { dryRun, dedupeSuffix, userId } = parseArgs(process.argv.slice(2));
  const now = new Date();

  if (!process.env.RESEND_API_KEY && !dryRun) {
    console.error("RESEND_API_KEY is not set — aborting.");
    process.exit(1);
  }

  // This boots the full AppModule to reach its providers, which also starts
  // every @Cron in the app — so an operator running this against production
  // becomes a second replica for as long as the command is open, firing the
  // every-minute reconciliation and the managers' reply job from their laptop.
  // Set before the module is evaluated.
  process.env.DISABLE_SCHEDULERS = "true";

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const prisma = app.get(PrismaService);
    const emailNotifications = app.get(EmailNotificationsService);

    const users = await prisma.user.findMany({
      where: {
        rubiesAccountNumber: { not: null },
        ...(userId ? { id: userId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    const periodLabel = formatPreviousWatMonthLabel(now);
    console.log(
      `${dryRun ? "DRY-RUN" : "LIVE"} — ${users.length} user(s), recap period: ${periodLabel}, dedupe suffix: ${dedupeSuffix}`,
    );

    let sent = 0;
    let skippedNoEmail = 0;
    let failed = 0;

    for (const user of users) {
      if (!user.email) {
        skippedNoEmail++;
        console.log(`skip ${user.id} — no email on file`);
        continue;
      }

      if (dryRun) {
        console.log(`would send to ${user.email} (${user.name ?? user.id})`);
        continue;
      }

      await emailNotifications.sendMonthlySummary(user, now, { dedupeSuffix });
      const fullDedupeKey = `MONTHLY:${user.id}:${dateKey(startOfWatMonthInstant(now))}:${dedupeSuffix}`;
      const log = await prisma.emailLog.findFirst({
        where: {
          userId: user.id,
          type: "MONTHLY_SUMMARY",
          dedupeKey: fullDedupeKey,
        },
        orderBy: { createdAt: "desc" },
      });

      if (log?.status === "SENT") {
        sent++;
        console.log(`sent ${user.email}`);
      } else if (log?.status === "SKIPPED") {
        console.log(`skipped ${user.email} — ${log.error ?? log.status}`);
      } else {
        failed++;
        console.log(
          `failed ${user.email} — ${log?.status ?? "unknown"} ${log?.error ?? ""}`,
        );
      }
    }

    if (!dryRun) {
      console.log(
        `done — sent: ${sent}, no email: ${skippedNoEmail}, failed/other: ${failed}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
