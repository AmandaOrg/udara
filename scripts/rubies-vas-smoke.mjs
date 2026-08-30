/**
 * Read-only Rubies BaaS VAS smoke test. Loads .env from repo root.
 * Does NOT call purchase (avoids spending funds on prod).
 */
import fs from "node:fs";
import path from "node:path";

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

if (!base || !stage || !key) {
  console.error("Missing RUBIES_BASE_URL, RUBIES_STAGE, or RUBIES_API_KEY");
  process.exit(1);
}

console.log(`Target: ${base}/${stage}`);
console.log("(Purchase skipped — read-only catalog + balance check)\n");

async function post(apiPath, body) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
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
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data };
}

function summarize(label, r) {
  console.log(`\n=== ${label} (HTTP ${r.status}) ===`);
  const d = r.data;
  console.log(`responseCode: ${d.responseCode ?? "n/a"} | ${d.responseMessage ?? ""}`);
  if (Array.isArray(d.data)) {
    console.log(`data count: ${d.data.length}`);
    console.log(JSON.stringify(d.data.slice(0, 5), null, 2));
  } else {
    console.log(JSON.stringify(d, null, 2).slice(0, 2500));
  }
}

const cats = await post("/baas-vas/getCategories", { request: "AIRTIME" });
summarize("getCategories (AIRTIME filter)", cats);

const allCats = await post("/baas-vas/getCategories", { request: "ALL" });
summarize("getCategories (ALL)", allCats);

const categoryList = Array.isArray(allCats.data?.data)
  ? allCats.data.data
  : Array.isArray(cats.data?.data)
    ? cats.data.data
    : [];

const airtimeCat =
  categoryList.find((c) =>
    /airtime/i.test(String(c.categoryCode ?? c.categoryName ?? "")),
  ) ?? categoryList[0];

if (airtimeCat) {
  const code = airtimeCat.categoryCode ?? airtimeCat.code;
  console.log(
    `\nUsing category: ${code} (${airtimeCat.categoryName ?? airtimeCat.name ?? ""})`,
  );
  const billers = await get(`/baas-vas/getBillers/${encodeURIComponent(code)}`);
  summarize(`getBillers/${code}`, billers);

  const products = await get("/baas-vas/products");
  summarize("getProducts (all)", products);

  const plist = Array.isArray(products.data?.data) ? products.data.data : [];
  const airProducts = plist.filter((p) =>
    /airtime|mtn|glo|airtel|9mobile/i.test(
      `${p.productCode ?? ""}${p.productName ?? ""}${p.productBillerCode ?? ""}`,
    ),
  );
  console.log(`\nAirtime-like products found: ${airProducts.length}`);
  console.log(JSON.stringify(airProducts.slice(0, 8), null, 2));
} else {
  console.log("\nNo categories returned — VAS may not be enabled on this merchant key.");
}

const feesAcct = process.env.RUBIES_FEES_ACCOUNT_NUMBER;
if (feesAcct) {
  const bal = await post("/baas-wallet/balance-enquiry", {
    accountNumber: feesAcct,
  });
  summarize("balance-enquiry (fees account)", bal);
}
