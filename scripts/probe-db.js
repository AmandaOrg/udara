require("dotenv").config({ override: true });
const { PrismaClient } = require("@prisma/client");

async function tryUrl(label, url) {
  const p = new PrismaClient({ datasources: { db: { url } } });
  try {
    await p.$queryRaw`SELECT 1`;
    console.log(label + ": OK");
    return true;
  } catch (e) {
    console.log(
      label +
        ": FAIL " +
        (e.code || "") +
        " " +
        String(e.message || "")
          .split("\n")[0]
          .slice(0, 120),
    );
    return false;
  } finally {
    await p.$disconnect().catch(() => {});
  }
}

(async () => {
  const u = process.env.DATABASE_URL || "";
  console.log("has_sslmode", /sslmode=/i.test(u));
  if (await tryUrl("as-is", u)) return;
  const joiner = u.includes("?") ? "&" : "?";
  if (!/sslmode=/i.test(u)) {
    if (await tryUrl("sslmode=require", u + joiner + "sslmode=require")) {
      process.exitCode = 2;
      return;
    }
    await tryUrl("sslmode=no-verify", u + joiner + "sslmode=no-verify");
  }
})();
