import {
  inferBillSurfaceFromText,
  isBillPaymentUtterance,
  sanitizeBillHintFields,
} from "./bill-hints.util";

describe("bill-hints.util", () => {
  it("classifies electricity vs airtime vs data", () => {
    expect(inferBillSurfaceFromText("pay nepa")).toBe("electricity_wizard");
    expect(inferBillSurfaceFromText("buy 2k mtn airtime")).toBe(
      "bill_payment_wizard",
    );
    expect(inferBillSurfaceFromText("buy data for my phone")).toBe(
      "data_bundle_wizard",
    );
    expect(inferBillSurfaceFromText("send 5k to my landlord")).toBeNull();
  });

  it("is a bill utterance only for product language", () => {
    expect(isBillPaymentUtterance("pay electricity")).toBe(true);
    expect(isBillPaymentUtterance("pay 5k to james")).toBe(false);
  });

  it("keeps plausible phone and meter digits", () => {
    expect(
      sanitizeBillHintFields({ msisdn: "0803 123 4567", telco_hint: "mtn" }),
    ).toEqual({ msisdn: "08031234567", telcoHint: "mtn" });
    expect(sanitizeBillHintFields({ meter: "12345" }).meter).toBeUndefined();
  });
});
