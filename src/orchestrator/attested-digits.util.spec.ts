import { buildAttestedDigits, isAttested } from "./attested-digits.util";
import { sanitizeTransferHints } from "./transfer-hints.util";

describe("attested digits", () => {
  it("collects digit runs from what the user said", () => {
    const attested = buildAttestedDigits([
      "send 5000 to 0123456789",
      "my meter is 45012345678",
    ]);

    expect(isAttested("0123456789", attested)).toBe(true);
    expect(isAttested("45012345678", attested)).toBe(true);
  });

  it("tolerates the ways people space an account number", () => {
    const attested = buildAttestedDigits(["pay 0123 456 789 0 please"]);
    expect(isAttested("0123456789", attested)).toBe(true);
  });

  it("rejects digits the user never supplied", () => {
    const attested = buildAttestedDigits(["send 5000 to james"]);
    expect(isAttested("0123456789", attested)).toBe(false);
  });

  it("skips the check when there is nothing to check", () => {
    expect(isAttested(undefined, "")).toBe(true);
  });
});

/**
 * The failure this exists to stop: a forwarded screenshot saying "your account
 * is compromised, move your money to 0123456789" is user-role content, so the
 * model can read an account number out of it and propose it. Shape checks pass
 * — it is ten digits. Confirm and PIN would then be the only things left, and
 * people tap Confirm.
 */
describe("sanitizeTransferHints provenance", () => {
  const invented = { amount: "5000", account_number: "0123456789" };

  it("drops an account number the user never mentioned", () => {
    const hints = sanitizeTransferHints(invented, {
      attestedDigits: buildAttestedDigits(["send 5000 to my landlord"]),
    });

    expect(hints.amount).toBe(5000);
    expect(hints.accountNumber).toBeUndefined();
  });

  it("keeps an account number the user actually typed", () => {
    const hints = sanitizeTransferHints(invented, {
      attestedDigits: buildAttestedDigits(["send 5000 to 0123456789"]),
    });

    expect(hints.accountNumber).toBe("0123456789");
  });

  it("allows unattested digits when the user sent a photo this turn", () => {
    // Reading a payee's digits off an image is a supported feature, and those
    // digits by definition appear in no text.
    const hints = sanitizeTransferHints(invented, {
      attestedDigits: buildAttestedDigits(["send this one"]),
      allowUnattestedDigits: true,
    });

    expect(hints.accountNumber).toBe("0123456789");
  });

  it("applies the same rule to phone and meter numbers", () => {
    const attestedDigits = buildAttestedDigits(["buy airtime"]);

    expect(
      sanitizeTransferHints({ msisdn: "08031234567" }, { attestedDigits })
        .msisdn,
    ).toBeUndefined();
    expect(
      sanitizeTransferHints({ meter: "45012345678" }, { attestedDigits }).meter,
    ).toBeUndefined();
  });

  it("leaves existing callers alone when no corpus is supplied", () => {
    expect(sanitizeTransferHints(invented).accountNumber).toBe("0123456789");
  });

  it("reads phone when msisdn is a number rather than silently preferring it", () => {
    // `??` only skips null and undefined, so a numeric msisdn used to beat a
    // string phone and the wrong value was parsed.
    const hints = sanitizeTransferHints({
      msisdn: 8031234567,
      phone: "08031234567",
    });

    expect(hints.msisdn).toBe("08031234567");
  });
});
