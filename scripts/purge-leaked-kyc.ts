/**
 * One-off: scrubs BVN/NIN and date-of-birth values that were persisted to
 * WhatsappMessage before redaction existed at the persistence boundary.
 *
 * Deliberately reuses the same redactSensitive/redactRawPayload functions the
 * live pipeline now uses, rather than hand-rolled SQL: the values live inside
 * a JSON-encoded string nested in the payload, and a regex over the text form
 * risks corrupting the surrounding JSON. Reusing the tested functions also
 * guarantees historical rows end up in exactly the shape new rows have.
 *
 * Dry-run by default. Pass --apply to write.
 */
import { PrismaClient } from "@prisma/client";
import {
  redactRawPayload,
  redactSensitive,
} from "../src/whatsapp/sensitive-fields.util";

const APPLY = process.argv.includes("--apply");

async function main() {
  const prisma = new PrismaClient();
  try {
    // Fetched in full and filtered in JS: the values are nested inside a
    // JSON-encoded string, which SQL-side jsonb predicates can't see into.
    const rows = await prisma.whatsappMessage.findMany({
      select: { id: true, flowResponseJson: true, rawPayload: true },
    });

    let changed = 0;
    for (const row of rows) {
      const nextFlow =
        row.flowResponseJson === null
          ? null
          : redactSensitive(row.flowResponseJson);
      const nextRaw = redactRawPayload(row.rawPayload);

      const flowChanged =
        JSON.stringify(nextFlow) !== JSON.stringify(row.flowResponseJson);
      const rawChanged =
        JSON.stringify(nextRaw) !== JSON.stringify(row.rawPayload);
      if (!flowChanged && !rawChanged) continue;

      changed += 1;
      if (APPLY) {
        await prisma.whatsappMessage.update({
          where: { id: row.id },
          data: {
            ...(flowChanged ? { flowResponseJson: nextFlow as never } : {}),
            ...(rawChanged ? { rawPayload: nextRaw as never } : {}),
          },
        });
      }
    }

    console.log(`scanned ${rows.length} row(s)`);
    console.log(
      APPLY
        ? `scrubbed ${changed} row(s)`
        : `${changed} row(s) WOULD be scrubbed (dry run)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
