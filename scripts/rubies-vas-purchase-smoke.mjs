/**
 * One-off Rubies VAS purchase smoke test. Loads .env from repo root.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const envPath = path.join(process.cwd(), ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
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
const stage = process.env.RUBIES_STAGE;
const key = process.env.RUBIES_API_KEY;

const accountNumber = process.argv[2] ?? "0000000000";
const msisdn = process.argv[3] ?? "08000000000";
const amount = process.argv[4] ?? "200";
const productCode = process.argv[5] ?? "AIRTEL_AIRTIME_PREPAID";

if (!base || !stage || !key) {
  console.error("Missing Rubies env");
  process.exit(1);
}

const reference = `UDARA-SMOKE-${randomUUID().slice(0, 8).toUpperCase()}`;

async function post(apiPath, body) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 1000) };
  }
  return { status: res.status, data };
}

async function get(apiPath) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 1000) };
  }
  return { status: res.status, data };
}

console.log(`Target: ${base}/${stage}`);
console.log(`Purchase: ${productCode} ₦${amount} → ${msisdn}, debit ${accountNumber}`);
console.log(`Reference: ${reference}\n`);

const purchaseBody = {
  reference,
  accountNumber,
  billerCustomerId: msisdn,
  productCode,
  amount: `${amount}.0`,
};

const purchase = await post("/baas-vas/purchase", purchaseBody);
console.log("=== purchase (HTTP", purchase.status, ") ===");
console.log(JSON.stringify(purchase.data, null, 2));

const queryRef =
  purchase.data?.reference ??
  purchase.data?.requestReference ??
  reference;

for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const tsq = await get(
    `/baas-vas/transaction-query/${encodeURIComponent(queryRef)}`,
  );
  console.log(`\n=== transaction-query attempt ${i + 1} (HTTP ${tsq.status}) ===`);
  console.log(JSON.stringify(tsq.data, null, 2));
  const code = tsq.data?.responseCode ?? tsq.data?.data?.responseCode;
  if (code === "00") break;
  if (code && code !== "09" && code !== "90" && code !== "99") break;
}

const bal = await post("/baas-wallet/balance-enquiry", { accountNumber });
console.log("\n=== balance after purchase ===");
console.log(
  `account ${bal.data?.accountNumber}: ₦${bal.data?.accountBalance} (code ${bal.data?.responseCode})`,
);
