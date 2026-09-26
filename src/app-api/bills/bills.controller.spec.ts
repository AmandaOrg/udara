import { BillsController } from "./bills.controller";

describe("BillsController", () => {
  it("offers what the WhatsApp wizards offer", () => {
    const catalog = new BillsController().catalog();

    expect(catalog.airtime.networks.map((n) => n.label)).toEqual([
      "MTN",
      "Airtel",
      "Glo",
      "9mobile",
    ]);
    expect(catalog.airtime).toMatchObject({ minAmount: 50, maxAmount: 50_000 });
    expect(catalog.data.networks.every((n) => n.bundles.length > 0)).toBe(true);
    expect(catalog.electricity.companies[0]).toEqual({
      billerCode: "IKEDC",
      productCode: "IKEDC_PREPAID",
      label: "Ikeja Electric",
    });
  });
});
