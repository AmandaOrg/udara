import {
  findDataBundle,
  findDataTelco,
  findElectricityDisco,
  normalizeMeterNumber,
} from "./bill-payment-catalog";

describe("bill-payment-catalog", () => {
  it("finds data telcos and bundles", () => {
    expect(findDataTelco("MTN_DATA")?.label).toBe("MTN");
    const bundle = findDataBundle("MTN_DATA", "MTN_DATA_7GB_30D");
    expect(bundle?.amount).toBe(3500);
  });

  it("finds electricity discos with prepaid product codes", () => {
    const disco = findElectricityDisco("IKEDC");
    expect(disco?.productCode).toBe("IKEDC_PREPAID");
    expect(findElectricityDisco("EEDC")?.productCode).toBe("ENUGU_PREPAID");
  });

  it("normalizes meter numbers", () => {
    expect(normalizeMeterNumber("4503 8890 1234")).toBe("450388901234");
    expect(normalizeMeterNumber("123")).toBeNull();
  });
});
