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
const acct = "1000013562";

async function post(apiPath, body) {
  const res = await fetch(`${base}/${stage}${apiPath}`, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

console.log("wallet:", JSON.stringify(await post("/baas-wallet/retrieve-wallet-details", { accountNumber: acct }), null, 2));

const attempts = [
  { productCode: "AIRTEL_AIRTIME_PREPAID", amount: "200.00", billerCustomerId: "07080007565" },
  { productCode: "AIRTEL_AIRTIME_PREPAID", amount: "200.00", billerCustomerId: "2347080007565" },
  { productCode: "MTN_AIRTIME_PREPAID", amount: "200.00", billerCustomerId: "07080007565" },
  { productCode: "AIRTEL_AIRTIME_PREPAID", amount: "100.00", billerCustomerId: "07080007565", customerName: "Udara Smoke Test" },
];

for (const body of attempts) {
  const ref = `UDARA-TRY-${Date.now()}`;
  const r = await post("/baas-vas/purchase", { reference: ref, accountNumber: acct, ...body });
  console.log("\ntry", JSON.stringify(body), "=>", r.responseCode, r.responseMessage);
}
