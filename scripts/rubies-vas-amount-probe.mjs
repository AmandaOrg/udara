import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}

const base = process.env.RUBIES_BASE_URL;
const stage = process.env.RUBIES_STAGE;
const key = process.env.RUBIES_API_KEY;
const acct = "1000013562";
const msisdn = "07080007565";

async function post(apiPath, body) {
  const res = await fetch(`${base}/${stage}${apiPath}`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(apiPath) {
  const res = await fetch(`${base}/${stage}${apiPath}`, { headers: { Authorization: key } });
  return res.json();
}

async function purchase(amount) {
  const reference = `UDARA-${randomUUID().slice(0, 8).toUpperCase()}`;
  const r = await post("/baas-vas/purchase", {
    reference,
    accountNumber: acct,
    productCode: "AIRTEL_AIRTIME_PREPAID",
    billerCustomerId: msisdn,
    amount: `${amount}.00`,
  });
  console.log(`\n₦${amount}:`, r.responseCode, r.responseMessage, "| ref:", r.reference ?? r.requestReference ?? reference);
  const ref = r.reference ?? r.requestReference ?? reference;
  await new Promise((x) => setTimeout(x, 2500));
  const tsq = await get(`/baas-vas/transaction-query/${encodeURIComponent(ref)}`);
  console.log("  tsq:", tsq.responseCode, tsq.responseMessage, tsq.responseMessage ? "" : JSON.stringify(tsq).slice(0, 300));
  return r;
}

const balBefore = await post("/baas-wallet/balance-enquiry", { accountNumber: acct });
console.log("Balance before:", balBefore.accountBalance);

await purchase(200);
const balAfter200 = await post("/baas-wallet/balance-enquiry", { accountNumber: acct });
console.log("Balance after ₦200 attempt:", balAfter200.accountBalance);

for (const amt of [150, 100]) {
  await purchase(amt);
}

const balFinal = await post("/baas-wallet/balance-enquiry", { accountNumber: acct });
console.log("\nFinal balance:", balFinal.accountBalance);
