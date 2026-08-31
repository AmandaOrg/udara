import fs from "node:fs";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}

const base = process.env.RUBIES_BASE_URL;
const key = process.env.RUBIES_API_KEY;

const r = await fetch(`${base}/v3/api-docs/BAAS-API`, {
  headers: { Authorization: key },
});
const j = await r.json();
for (const p of Object.keys(j.paths || {}).filter((x) => /vas/i.test(x))) {
  const methods = Object.keys(j.paths[p]);
  console.log(`${methods.join(",")} ${p}`);
  for (const m of methods) {
    const op = j.paths[p][m];
    if (op?.requestBody) {
      console.log("  body:", JSON.stringify(op.requestBody).slice(0, 300));
    }
  }
}
