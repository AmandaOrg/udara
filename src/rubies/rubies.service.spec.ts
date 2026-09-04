import { of, throwError } from "rxjs";
import { AxiosError } from "axios";
import {
  RubiesService,
  mapRubiesResponseCode,
  mapRubiesResponseCodeStrict,
} from "./rubies.service";

describe("mapRubiesResponseCode", () => {
  it('maps "00" to SUCCESS', () => {
    expect(mapRubiesResponseCode("00")).toBe("SUCCESS");
  });

  it.each(["09", "90", "99"])('maps "%s" to PENDING', (code) => {
    expect(mapRubiesResponseCode(code)).toBe("PENDING");
  });

  it.each(["25", "01", "", undefined, null])(
    "maps %p to FAILED (any other code)",
    (code) => {
      expect(mapRubiesResponseCode(code)).toBe("FAILED");
    },
  );
});

/**
 * The strict variant exists because "we did not get an answer" and "the transfer
 * failed" are opposite facts, and recording the second when the first is true is
 * how a customer gets told nothing was deducted after their money left.
 */
describe("mapRubiesResponseCodeStrict", () => {
  it("agrees with the plain mapping on every code Rubies actually documents", () => {
    expect(mapRubiesResponseCodeStrict("00")).toBe("SUCCESS");
    expect(mapRubiesResponseCodeStrict("09")).toBe("PENDING");
    expect(mapRubiesResponseCodeStrict("25")).toBe("FAILED");
  });

  it.each([undefined, null, ""])(
    "treats a missing code (%p) as PENDING, not FAILED",
    (code) => {
      expect(mapRubiesResponseCodeStrict(code)).toBe("PENDING");
    },
  );
});

describe("RubiesService", () => {
  let http: { post: jest.Mock };
  let config: { get: jest.Mock };
  let service: RubiesService;

  const envDefaults: Record<string, string> = {
    RUBIES_BASE_URL: "https://api-sme-dev.rubies.ng",
    RUBIES_STAGE: "dev",
    RUBIES_API_KEY: "test-key",
    RUBIES_DRY_RUN: "false",
  };

  beforeEach(() => {
    http = { post: jest.fn() };
    config = {
      get: jest.fn(
        (key: string, fallback?: string) => envDefaults[key] ?? fallback,
      ),
    };
    service = new RubiesService(http as any, config as any);
  });

  describe("live calls (RUBIES_DRY_RUN=false)", () => {
    it("provisionAccount posts to baas-wallet/create-wallet, then retrieve-wallet-details for the real per-wallet accountId", async () => {
      http.post
        .mockReturnValueOnce(
          of({
            data: {
              // customerId is Rubies' ID for our organisation, not this
              // wallet — provisionAccount must NOT surface it as accountId.
              customerId: "BUS0000000135",
              accountNumber: "0123456789",
              accountName: "John Doe",
              responseCode: "00",
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: { accountId: "244623", responseCode: "00" },
          }),
        );

      const account = await service.provisionAccount({
        bvn: "12345678901",
        firstName: "John",
        lastName: "Doe",
        phoneNumber: "08012345678",
      });

      expect(http.post).toHaveBeenNthCalledWith(
        1,
        "https://api-sme-dev.rubies.ng/dev/baas-wallet/create-wallet",
        expect.objectContaining({
          bvn: "12345678901",
          firstName: "John",
          lastName: "Doe",
        }),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "test-key" }),
        }),
      );
      expect(http.post).toHaveBeenNthCalledWith(
        2,
        "https://api-sme-dev.rubies.ng/dev/baas-wallet/retrieve-wallet-details",
        { accountNumber: "0123456789" },
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "test-key" }),
        }),
      );
      expect(account).toEqual({
        accountId: "244623", // the real per-wallet ID, not customerId
        accountNumber: "0123456789",
        accountName: "John Doe",
        bankCode: "090175",
      });
    });

    it("surfaces a retrieve-wallet-details failure instead of returning a bogus accountId", async () => {
      http.post
        .mockReturnValueOnce(
          of({
            data: {
              customerId: "BUS0000000135",
              accountNumber: "0123456789",
              accountName: "John Doe",
              responseCode: "00",
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: { responseCode: "99", responseMessage: "Not found" },
          }),
        );

      await expect(
        service.provisionAccount({
          bvn: "12345678901",
          firstName: "John",
          lastName: "Doe",
          phoneNumber: "08012345678",
        }),
      ).rejects.toThrow("Not found");
    });

    it("rejects both bvn and nin supplied together", async () => {
      await expect(
        service.provisionAccount({
          bvn: "1",
          nin: "2",
          firstName: "A",
          lastName: "B",
          phoneNumber: "0800",
        }),
      ).rejects.toThrow(/exactly one/);
      expect(http.post).not.toHaveBeenCalled();
    });

    it("rejects neither bvn nor nin supplied", async () => {
      await expect(
        service.provisionAccount({
          firstName: "A",
          lastName: "B",
          phoneNumber: "0800",
        }),
      ).rejects.toThrow(/exactly one/);
    });

    it("surfaces a KYC name-mismatch failure as a normal error, not a crash", async () => {
      http.post.mockReturnValue(
        of({
          data: {
            customerId: null,
            accountNumber: null,
            responseCode: "25",
            responseMessage: "First name does not match",
          },
        }),
      );

      await expect(
        service.provisionAccount({
          bvn: "12345678901",
          firstName: "Wrong",
          lastName: "Name",
          phoneNumber: "0800",
        }),
      ).rejects.toThrow("First name does not match");
    });

    it("initiateTransfer maps a successful responseCode to SUCCESS", async () => {
      http.post.mockReturnValue(
        of({
          data: {
            reference: "REF-1",
            sessionId: "SESSION-1",
            responseCode: "00",
          },
        }),
      );

      const result = await service.initiateTransfer({
        fromAccountNumber: "111",
        fromAccountName: "A",
        toAccountNumber: "222",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 5000,
        narration: "test",
        idempotencyKey: "REF-1",
      });

      expect(result).toEqual({
        reference: "REF-1",
        status: "SUCCESS",
        responseCode: "00",
        responseMessage: undefined,
        sessionId: "SESSION-1",
      });
    });

    it("initiateTransfer maps a pending responseCode to PENDING, not SUCCESS", async () => {
      http.post.mockReturnValue(
        of({ data: { reference: "REF-2", responseCode: "09" } }),
      );

      const result = await service.initiateTransfer({
        fromAccountNumber: "111",
        fromAccountName: "A",
        toAccountNumber: "222",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 5000,
        narration: "test",
        idempotencyKey: "REF-2",
      });

      expect(result.status).toBe("PENDING");
    });

    it("initiateTransfer maps any other responseCode to FAILED", async () => {
      http.post.mockReturnValue(
        of({
          data: {
            reference: "REF-3",
            responseCode: "25",
            responseMessage: "Reversed",
          },
        }),
      );

      const result = await service.initiateTransfer({
        fromAccountNumber: "111",
        fromAccountName: "A",
        toAccountNumber: "222",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 5000,
        narration: "test",
        idempotencyKey: "REF-3",
      });

      expect(result.status).toBe("FAILED");
      expect(result.responseMessage).toBe("Reversed");
    });

    it("initiateTransfer reports PENDING, never FAILED, when the response carries no code", async () => {
      // A 200 with a body that isn't the documented shape. FAILED here would tell
      // the customer nothing was deducted and close the transfer permanently;
      // PENDING keeps it alive for the reconciliation job to resolve.
      http.post.mockReturnValue(of({ data: { reference: "REF-4" } }));

      const result = await service.initiateTransfer({
        fromAccountNumber: "111",
        fromAccountName: "A",
        toAccountNumber: "222",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 5000,
        narration: "test",
        idempotencyKey: "REF-4",
      });

      expect(result.status).toBe("PENDING");
    });

    it("sends money with a longer timeout than an interactive lookup", async () => {
      http.post.mockReturnValue(
        of({ data: { reference: "REF-5", responseCode: "00" } }),
      );

      await service.initiateTransfer({
        fromAccountNumber: "111",
        fromAccountName: "A",
        toAccountNumber: "222",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 5000,
        narration: "test",
        idempotencyKey: "REF-5",
      });

      const [, , config] = http.post.mock.calls.at(-1) as [
        string,
        unknown,
        { timeout: number },
      ];
      expect(config.timeout).toBe(60_000);
    });

    it("queryTransferStatus (tsq) uses the same response-code mapping as initiateTransfer", async () => {
      http.post.mockReturnValue(of({ data: { responseCode: "90" } }));
      const result = await service.queryTransferStatus("REF-1");
      expect(result.status).toBe("PENDING");
    });

    it("nameEnquiry throws when the account cannot be resolved", async () => {
      http.post.mockReturnValue(
        of({
          data: {
            responseCode: "25",
            responseMessage: "Could not find wallet details",
          },
        }),
      );
      await expect(
        service.nameEnquiry({ accountNumber: "000", bankCode: "000005" }),
      ).rejects.toThrow("Could not find wallet details");
    });

    it("getBalance parses accountBalance as a number", async () => {
      http.post.mockReturnValue(
        of({ data: { accountBalance: "12500.50", responseCode: "00" } }),
      );
      const balance = await service.getBalance("0123456789");
      expect(balance).toBe(12500.5);
    });

    it("surfaces the structured error body on an HTTP error response instead of throwing raw", async () => {
      const axiosError = new AxiosError("Request failed with status code 400");
      axiosError.response = {
        data: { responseCode: "25", responseMessage: "Bad request" },
      } as any;
      http.post.mockReturnValue(throwError(() => axiosError));

      const result = await service.getBalance("0123456789").catch((e) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("Bad request");
    });

    it("throws a generic error when Rubies is unreachable (no structured response body)", async () => {
      http.post.mockReturnValue(throwError(() => new Error("ECONNREFUSED")));
      await expect(service.getBalance("0123456789")).rejects.toThrow(
        "Could not reach Rubies",
      );
    });

    /**
     * The failure this whole change exists for. A gateway in front of Rubies
     * answers 502 with an HTML page. That body is truthy, so it used to be
     * returned as if it were Rubies' own verdict; it has no responseCode, which
     * mapped to FAILED, which told the customer nothing was deducted and marked
     * the transfer terminal so nothing ever rechecked it. A 502 is exactly the
     * case where the debit may already have landed.
     */
    it.each([
      ["an HTML gateway page", "<html><body>502 Bad Gateway</body></html>"],
      ["an error envelope with no responseCode", { error: "rate limited" }],
      ["an empty object", {}],
      ["a non-string responseCode", { responseCode: 0 }],
    ])("throws rather than treating %s as a verdict", async (_label, body) => {
      const axiosError = new AxiosError("Request failed with status code 502");
      axiosError.response = { data: body, status: 502 } as any;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(service.getBalance("0123456789")).rejects.toThrow(
        "Could not reach Rubies",
      );
    });

    it("still accepts a genuine Rubies error body, which does carry a code", async () => {
      const axiosError = new AxiosError("Request failed with status code 400");
      axiosError.response = {
        data: { responseCode: "51", responseMessage: "Insufficient funds" },
        status: 400,
      } as any;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(service.getBalance("0123456789")).rejects.toThrow(
        "Insufficient funds",
      );
    });
  });

  describe("dry-run mode (RUBIES_DRY_RUN=true)", () => {
    beforeEach(() => {
      envDefaults.RUBIES_DRY_RUN = "true";
    });
    afterEach(() => {
      envDefaults.RUBIES_DRY_RUN = "false";
    });

    it("never makes a real HTTP call for any method", async () => {
      await service.provisionAccount({
        bvn: "1",
        firstName: "A",
        lastName: "B",
        phoneNumber: "0800",
      });
      await service.nameEnquiry({ accountNumber: "1", bankCode: "000005" });
      await service.getBalance("1");
      await service.initiateTransfer({
        fromAccountNumber: "1",
        fromAccountName: "A",
        toAccountNumber: "2",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 100,
        narration: "x",
        idempotencyKey: "key-1",
      });
      await service.queryTransferStatus("key-1");
      await service.listBanks();
      await service.purchaseVas({
        accountNumber: "1000013562",
        billerCustomerId: "07080007565",
        productCode: "MTN_AIRTIME_PREPAID",
        amount: 200,
        requestReference: "UDARA-BILL-test",
      });
      await service.queryVasTransaction("UDARA-BILL-test");
      await service.validateVasCustomer({
        billerCode: "IKEDC",
        productCode: "IKEDC_PREPAID",
        billerCustomerId: "4503889012345",
      });

      expect(http.post).not.toHaveBeenCalled();
    });

    it("purchaseVas dry-run returns SUCCESS with the request reference", async () => {
      const result = await service.purchaseVas({
        accountNumber: "1000013562",
        billerCustomerId: "07080007565",
        productCode: "MTN_AIRTIME_PREPAID",
        amount: 200,
        requestReference: "UDARA-BILL-42",
        customerName: "Test User",
      });
      expect(result).toEqual({
        requestReference: "UDARA-BILL-42",
        reference: "UDARA-BILL-42",
        status: "SUCCESS",
        responseCode: "00",
        vendorToken: "1234-5678-9012-3456-7890",
      });
    });

    it("validateVasCustomer dry-run returns a fake customer name", async () => {
      const result = await service.validateVasCustomer({
        billerCode: "IKEDC",
        productCode: "IKEDC_PREPAID",
        billerCustomerId: "4503889012345",
      });
      expect(result).toEqual({
        ok: true,
        customerName: "DRY RUN CUSTOMER",
        responseCode: "00",
      });
    });

    it("initiateTransfer echoes back the idempotencyKey as the reference with SUCCESS status", async () => {
      const result = await service.initiateTransfer({
        fromAccountNumber: "1",
        fromAccountName: "A",
        toAccountNumber: "2",
        toBankCode: "000005",
        toAccountName: "B",
        amount: 100,
        narration: "x",
        idempotencyKey: "key-42",
      });
      expect(result).toEqual({
        reference: "key-42",
        status: "SUCCESS",
        responseCode: "00",
      });
    });
  });
});
