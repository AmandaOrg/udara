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

async function get(apiPath) {
  const res = await fetch(`${base}/${stage}${apiPath}`, { headers: { Authorization: key } });
  return res.json();
}

const product = await get("/baas-vas/products/MTN_AIRTIME_PREPAID");
console.log("product detail:", JSON.stringify(product, null, 2));

for (const amount of ["50.00", "200", "200.0"]) {
  const r = await post("/baas-vas/purchase", {
    reference: `UDARA-AMT-${Date.now()}`,
    accountNumber: "0000000000",
    productCode: "AIRTEL_AIRTIME_PREPAID",
    billerCustomerId: "08000000000",
    amount,
  });
  console.log(`amount=${amount} =>`, r.responseCode, r.responseMessage);
}
