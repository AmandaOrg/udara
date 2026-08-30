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
const stage = process.env.RUBIES_STAGE;
const key = process.env.RUBIES_API_KEY;

async function post(apiPath, body) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500), status: res.status };
  }
}

async function get(apiPath) {
  const url = `${base}/${stage}${apiPath}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  return res.json();
}

// Data products per biller
for (const biller of ["MTN_DATA", "AIRTEL_DATA", "GLO_DATA", "9MOBILE_DATA"]) {
  console.log(`\n=== products/data/${biller} ===`);
  const r = await get(`/baas-vas/products/data/${biller}`);
  const rows = Array.isArray(r?.data) ? r.data : [];
  console.log(`count: ${rows.length}`);
  for (const p of rows.slice(0, 8)) {
    console.log(
      JSON.stringify({
        productCode: p.productCode,
        productName: p.productName,
        productPrice: p.productPrice,
      }),
    );
  }
}

// customerEnquiry schema probe
const bodies = [
  { billerCode: "IKEDC", customerId: "12345678901", productCode: "IKEDC_PREPAID" },
  { billerCode: "IKEDC", billerCustomerId: "12345678901", productCode: "IKEDC_PREPAID" },
  { billerCode: "IKEDC", customerNumber: "12345678901", productCode: "IKEDC_PREPAID" },
];

for (const body of bodies) {
  console.log("\n=== customerEnquiry", JSON.stringify(body), "===");
  const r = await post("/baas-vas/customerEnquiry", body);
  console.log(JSON.stringify(r).slice(0, 600));
}
