/**
 * Read-only Phase B catalog probe: DATA_BUNDLE + ELECTRICITY + validate path.
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

async function post(apiPath, body) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function get(apiPath) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  return res.json();
}

for (const cat of ["DATA_BUNDLE", "ELECTRICITY"]) {
  console.log(`\n=== getBillers/${cat} ===`);
  const billers = await get(`/baas-vas/getBillers/${cat}`);
  console.log(JSON.stringify(billers?.data?.slice?.(0, 12) ?? billers, null, 2));
}

console.log("\n=== products sample (DATA + ELECTRICITY) ===");
const products = await get("/baas-vas/products");
const plist = Array.isArray(products?.data) ? products.data : [];
const filtered = plist.filter((p) =>
  /data|bundle|electric|prepaid|ikedc|ekedc|aedc|phed|disco|meter/i.test(
    `${p.productCode ?? ""}${p.productName ?? ""}${p.productBillerCode ?? ""}`,
  ),
);
console.log(`filtered count: ${filtered.length}`);
for (const p of filtered.slice(0, 30)) {
  console.log(
    JSON.stringify({
      productCode: p.productCode,
      productName: p.productName,
      productBillerCode: p.productBillerCode,
      productPrice: p.productPrice,
    }),
  );
}

// Try common validate paths
const validatePaths = [
  ["/baas-vas/validateCustomer", { billerCode: "IKEDC", customerId: "12345678901" }],
  ["/baas-vas/customer-validation", { billerCode: "IKEDC", customerId: "12345678901" }],
  ["/baas-vas/validate", { billerCode: "IKEDC", billerCustomerId: "12345678901" }],
  ["/baas-vas/biller-customer-validation", { billerCode: "IKEDC", billerCustomerId: "12345678901" }],
];

for (const [p, body] of validatePaths) {
  console.log(`\n=== POST ${p} ===`);
  try {
    const r = await post(p, body);
    console.log(JSON.stringify(r).slice(0, 500));
  } catch (e) {
    console.log(String(e));
  }
}

console.log("\n=== customerEnquiry (OpenAPI path) ===");
for (const body of [
  { billerCode: "IKEDC", customerId: "12345678901", productCode: "IKEDC_PREPAID" },
  { billerCode: "IKEDC", billerCustomerId: "12345678901", productCode: "IKEDC_PREPAID" },
]) {
  const r = await post("/baas-vas/customerEnquiry", body);
  console.log(JSON.stringify(body), "=>", JSON.stringify(r).slice(0, 400));
}

for (const biller of ["MTN_DATA", "AIRTEL_DATA"]) {
  console.log(`\n=== GET products/data/${biller} ===`);
  const r = await get(`/baas-vas/products/data/${biller}`);
  const rows = Array.isArray(r?.data) ? r.data : [];
  console.log(`count: ${rows.length}`);
  for (const p of rows.slice(0, 6)) {
    console.log(JSON.stringify({ productCode: p.productCode, productName: p.productName, productPrice: p.productPrice }));
  }
}

for (const biller of ["MTN_DATA", "AIRTEL_DATA", "GLO_DATA", "9MOBILE_DATA"]) {
  console.log(`\n=== POST getProduct ${biller} ===`);
  const r = await post("/baas-vas/getProduct", { billerCode: biller });
  const rows = Array.isArray(r?.data) ? r.data : [];
  console.log(`count: ${rows.length}, code: ${r.responseCode}`);
  for (const p of rows.slice(0, 8)) {
    console.log(JSON.stringify({ productCode: p.productCode, productName: p.productName, productPrice: p.productPrice }));
  }
}

console.log("\n=== 9MOBILE all bundles ===");
const nine = await post("/baas-vas/getProduct", { billerCode: "9MOBILE_DATA" });
for (const p of (nine.data || []).slice(0, 10)) {
  console.log(p.productCode, p.productPrice);
}
