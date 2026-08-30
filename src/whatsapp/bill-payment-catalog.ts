/** Curated Rubies VAS catalogs for Phase B (prod codes from live probe). */

export interface DataTelcoEntry {
  billerCode: string;
  label: string;
}

export interface DataBundleEntry {
  productCode: string;
  label: string;
  amount: number;
}

export interface ElectricityDiscoEntry {
  billerCode: string;
  productCode: string;
  label: string;
}

export const DATA_TELCOS: readonly DataTelcoEntry[] = [
  { billerCode: "MTN_DATA", label: "MTN" },
  { billerCode: "AIRTEL_DATA", label: "Airtel" },
  { billerCode: "GLO_DATA", label: "Glo" },
  { billerCode: "9MOBILE_DATA", label: "9mobile" },
];

/** Up to 8 popular bundles per telco — fits WhatsApp list cap with headroom. */
export const DATA_BUNDLES_BY_BILLER: Record<string, readonly DataBundleEntry[]> =
  {
    MTN_DATA: [
      { productCode: "MTN_DATA_3.5GB_7D", label: "3.5GB · 7 days", amount: 1500 },
      { productCode: "MTN_DATA_2GB_30D", label: "2GB · 30 days", amount: 1500 },
      { productCode: "MTN_DATA_7GB_30D", label: "7GB · 30 days", amount: 3500 },
      {
        productCode: "MTN_DATA_16.5GB_30D",
        label: "16.5GB · 30 days",
        amount: 6500,
      },
      { productCode: "MTN_DATA_20GB_30D", label: "20GB · 30 days", amount: 7500 },
      { productCode: "MTN_DATA_36GB_30D", label: "36GB · 30 days", amount: 11000 },
    ],
    AIRTEL_DATA: [
      {
        productCode: "AIRTEL_DATA_500MB_7D",
        label: "500MB · 7 days",
        amount: 500,
      },
      { productCode: "AIRTEL_DATA_3GB_30D", label: "3GB · 30 days", amount: 2000 },
      { productCode: "AIRTEL_DATA_8GB_30D", label: "8GB · 30 days", amount: 3000 },
      {
        productCode: "AIRTEL_DATA_10GB_30D",
        label: "10GB · 30 days",
        amount: 4000,
      },
      {
        productCode: "AIRTEL_DATA_13GB_30D",
        label: "13GB · 30 days",
        amount: 5000,
      },
      {
        productCode: "AIRTEL_DATA_18GB_30D",
        label: "18GB · 30 days",
        amount: 6000,
      },
    ],
    GLO_DATA: [
      { productCode: "GLO_DATA_1.55GB_7D", label: "1.55GB · 7 days", amount: 500 },
      { productCode: "GLO_DATA_2.6GB_30D", label: "2.6GB · 30 days", amount: 1000 },
      { productCode: "GLO_DATA_6.25GB_30D", label: "6.25GB · 30 days", amount: 2000 },
      { productCode: "GLO_DATA_7.25GB_30D", label: "7.25GB · 30 days", amount: 2500 },
      {
        productCode: "GLO_DATA_10.5GB_30D",
        label: "10.5GB · 30 days",
        amount: 3000,
      },
      {
        productCode: "GLO_DATA_12.5GB_30D",
        label: "12.5GB · 30 days",
        amount: 4000,
      },
    ],
    "9MOBILE_DATA": [
      {
        productCode: "9MOBILE_DATA_350MB_VD",
        label: "350MB",
        amount: 200,
      },
      {
        productCode: "9MOBILE_DATA_2.9GB_30D",
        label: "2.9GB · 30 days",
        amount: 1000,
      },
      {
        productCode: "9MOBILE_DATA_4.1GB_7D",
        label: "4.1GB · 7 days",
        amount: 1500,
      },
      {
        productCode: "9MOBILE_DATA_5.8GB_30D",
        label: "5.8GB · 30 days",
        amount: 2000,
      },
      {
        productCode: "9MOBILE_DATA_10GB_30D",
        label: "10GB · 30 days",
        amount: 3000,
      },
      {
        productCode: "9MOBILE_DATA_18.25GB_30D",
        label: "18.25GB · 30 days",
        amount: 5000,
      },
    ],
  };

/** Major prepaid DisCos — productCode is always {biller}_PREPAID on Rubies prod. */
export const ELECTRICITY_DISCOS: readonly ElectricityDiscoEntry[] = [
  { billerCode: "IKEDC", productCode: "IKEDC_PREPAID", label: "Ikeja Electric" },
  { billerCode: "EKEDC", productCode: "EKEDC_PREPAID", label: "Eko Electric" },
  { billerCode: "AEDC", productCode: "AEDC_PREPAID", label: "Abuja Electric" },
  { billerCode: "IBEDC", productCode: "IBEDC_PREPAID", label: "Ibadan Electric" },
  { billerCode: "PHEDC", productCode: "PHED_PREPAID", label: "Port Harcourt" },
  { billerCode: "KEDCO", productCode: "KEDCO_PREPAID", label: "Kano Electric" },
  { billerCode: "JEDC", productCode: "JEDC_PREPAID", label: "Jos Electric" },
  { billerCode: "KAEDCO", productCode: "KAEDCO_PREPAID", label: "Kaduna Electric" },
  { billerCode: "EEDC", productCode: "ENUGU_PREPAID", label: "Enugu Electric" },
];

export function findDataTelco(billerCode: string) {
  return DATA_TELCOS.find((t) => t.billerCode === billerCode);
}

export function findDataBundle(billerCode: string, productCode: string) {
  return DATA_BUNDLES_BY_BILLER[billerCode]?.find(
    (b) => b.productCode === productCode,
  );
}

export function bundlesForTelco(billerCode: string): readonly DataBundleEntry[] {
  return DATA_BUNDLES_BY_BILLER[billerCode] ?? [];
}

export function findElectricityDisco(billerCode: string) {
  return ELECTRICITY_DISCOS.find((d) => d.billerCode === billerCode);
}

/** Meter / customer id: digits only, typical 10–13 digits. */
export function normalizeMeterNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 13) return digits;
  return null;
}

export function formatBundleListTitle(bundle: DataBundleEntry): string {
  return `₦${bundle.amount.toLocaleString("en-NG")} · ${bundle.label.split(" · ")[0] ?? bundle.label}`.slice(
    0,
    24,
  );
}
