import fs from "node:fs";
import path from "node:path";

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

async function post(apiPath, body) {
  const res = await fetch(`${base}/${stage}${apiPath}`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const acct = "0000000000";
const txs = await post("/baas-wallet/read-all-wallet-transactions", {
  accountNumber: acct,
  startDate: "2026-08-28",
  endDate: "2026-08-30",
});
console.log("recent txs responseCode:", txs.responseCode, txs.responseMessage);
const list = txs.data ?? txs.transactions ?? txs.transactionList ?? [];
console.log("tx count:", Array.isArray(list) ? list.length : typeof list);
console.log(JSON.stringify(Array.isArray(list) ? list.slice(0, 10) : txs, null, 2).slice(0, 4000));

const vas = await post("/baas-vas/transactions", {});
console.log("\nvas transactions:", JSON.stringify(vas, null, 2).slice(0, 2000));
