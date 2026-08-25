/**
 * Prep local e2e: force dry-runs, sync .env.e2e verify token to server .env.
 * Does not print secret values.
 */
const fs = require("fs");

function parse(p) {
  const o = {};
  if (!fs.existsSync(p)) return o;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    o[t.slice(0, i).trim()] = v;
  }
  return o;
}

function setLine(env, k, v) {
  const re = new RegExp("^" + k + "=.*", "m");
  if (re.test(env)) return env.replace(re, k + "=" + v);
  return env.trimEnd() + "\n" + k + "=" + v + "\n";
}

const root = parse(".env");
let env = fs.readFileSync(".env", "utf8");
env = setLine(env, "RUBIES_DRY_RUN", "true");
env = setLine(env, "WHATSAPP_DRY_RUN", "true");
fs.writeFileSync(".env", env);

const token = (root.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "").trim();
if (!token) {
  console.error("missing WHATSAPP_WEBHOOK_VERIFY_TOKEN in .env");
  process.exit(1);
}

let e2e = fs.existsSync(".env.e2e")
  ? fs.readFileSync(".env.e2e", "utf8")
  : fs.readFileSync("e2e/.env.e2e.example", "utf8");
e2e = setLine(e2e, "WHATSAPP_WEBHOOK_VERIFY_TOKEN", token);
e2e = setLine(e2e, "E2E_BASE_URL", "http://127.0.0.1:3000");
e2e = setLine(e2e, "E2E_ORCHESTRATOR_LIVE", "1");
// Do not blank-out secrets: empty RUBIES_SECRET_KEY / WHATSAPP_APP_SECRET in
// .env.e2e would override a real value from .env and desync runner vs server.
const rubiesSecret = (root.RUBIES_SECRET_KEY || "").trim();
if (rubiesSecret) e2e = setLine(e2e, "RUBIES_SECRET_KEY", rubiesSecret);
else e2e = e2e.replace(/^RUBIES_SECRET_KEY=.*\r?\n?/m, "");
const waSecret = (root.WHATSAPP_APP_SECRET || "").trim();
if (waSecret) e2e = setLine(e2e, "WHATSAPP_APP_SECRET", waSecret);
else e2e = e2e.replace(/^WHATSAPP_APP_SECRET=.*\r?\n?/m, "");
fs.writeFileSync(".env.e2e", e2e);

const after = parse(".env");
console.log("forced RUBIES_DRY_RUN=true WHATSAPP_DRY_RUN=true");
console.log("synced verify token to .env.e2e (value not printed)");
console.log("E2E_ORCHESTRATOR_LIVE=1");
console.log("AI_PROVIDER=" + (after.AI_PROVIDER || ""));
console.log(
  "rubies_secret_set=" + !!(after.RUBIES_SECRET_KEY || "").trim(),
);
console.log(
  "wa_app_secret_set=" + !!(after.WHATSAPP_APP_SECRET || "").trim(),
);
