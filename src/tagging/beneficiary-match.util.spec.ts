import { Recipient, RecipientLabel } from "@prisma/client";
import {
  findAmbiguousBeneficiaryMatches,
  matchSavedBeneficiaries,
} from "./beneficiary-match.util";

function recipient(
  overrides: Partial<Recipient> & Pick<Recipient, "id">,
): Recipient {
  return {
    userId: "user-1",
    accountNumber: "0123456789",
    bankCode: "000013",
    accountName: "James Okonkwo",
    label: RecipientLabel.VENDOR,
    nickname: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Recipient;
}

describe("beneficiary-match.util", () => {
  it("matches exact nickname case-insensitively", () => {
    const matches = matchSavedBeneficiaries(
      [recipient({ id: "r1", nickname: "James" })],
      "james",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("r1");
  });

  it("matches unique accountName substring", () => {
    const matches = matchSavedBeneficiaries(
      [
        recipient({ id: "r1", accountName: "Samuel Egwu" }),
        recipient({ id: "r2", accountName: "Jane Doe" }),
      ],
      "samuel",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("r1");
  });

  it("returns empty when multiple account names match", () => {
    const matches = matchSavedBeneficiaries(
      [
        recipient({ id: "r1", accountName: "James Alpha" }),
        recipient({ id: "r2", accountName: "James Beta" }),
      ],
      "james",
    );
    expect(matches).toHaveLength(0);
  });

  it("findAmbiguousBeneficiaryMatches lists multiple nickname hits", () => {
    const ambiguous = findAmbiguousBeneficiaryMatches(
      [
        recipient({ id: "r1", nickname: "James" }),
        recipient({ id: "r2", nickname: "James" }),
      ],
      "james",
    );
    expect(ambiguous).toHaveLength(2);
  });
});
