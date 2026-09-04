import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import { AxiosError } from "axios";

export interface RubiesAccount {
  // Rubies' own per-wallet accountId (fetched via a retrieve-wallet-details
  // follow-up call — create-wallet's response never returns it) — maps onto
  // User.rubiesAccountId. Deliberately NOT create-wallet's `customerId`:
  // that's Rubies' identifier for *our organisation*, constant across every
  // wallet Kedu ever provisions, so it can never be a per-user unique key
  // (confirmed live: two real, distinct wallets both came back with the
  // same customerId — using it as User.rubiesAccountId caused a real
  // unique-constraint collision on the second real account created).
  accountId: string;
  accountNumber: string; // 10-digit wallet number — maps onto User.rubiesAccountNumber
  accountName: string; // KYC-matched account name — maps onto User.rubiesAccountName
  bankCode: string;
}

export interface RubiesTransferResult {
  reference: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  responseCode: string;
  responseMessage?: string;
  sessionId?: string;
}

export interface RubiesNameEnquiryResult {
  accountName: string;
  bankName: string;
}

export interface RubiesBank {
  bankCode: string;
  bankName: string;
}

export interface RubiesVasPurchaseResult {
  requestReference: string;
  reference: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  responseCode: string;
  responseMessage?: string;
  vendorToken?: string;
}

export interface RubiesVasCustomerLookupResult {
  ok: boolean;
  customerName?: string;
  responseCode: string;
  responseMessage?: string;
}

/**
 * Rubies MFB's own CBN bank code — constant across every wallet Rubies
 * provisions. Exported so callers sending money to another Rubies-hosted
 * wallet (e.g. TransferConfirmationService's fee sweep to the fees account)
 * don't need to hardcode it a second time.
 */
export const RUBIES_MFB_BANK_CODE = "090175";

/**
 * Rubies' shared response-code buckets, documented once at the API level
 * (not per-endpoint) and consistent across wallet and transaction calls:
 * 00 = success, 09/90/99 = pending — resolve via TSQ, never assume either
 * way — anything else = failed (funds reversed or the transaction was never
 * found). Exported as a pure function so it's independently unit-testable.
 */
export function mapRubiesResponseCode(
  code: string | undefined | null,
): "SUCCESS" | "PENDING" | "FAILED" {
  if (code === "00") return "SUCCESS";
  if (code === "09" || code === "90" || code === "99") return "PENDING";
  return "FAILED";
}

/**
 * Same mapping, except that a *missing* code means "we do not know" rather than
 * "it failed".
 *
 * Use this wherever recording a wrong FAILED would strand real money: a
 * transfer, a VAS purchase, or either of their status queries. PENDING keeps the
 * row alive for the reconciliation job; FAILED is terminal and tells the
 * customer nothing was deducted.
 *
 * Deliberately a separate function rather than a change to the one above, which
 * is also applied to webhook-supplied input and whose "anything else is failed"
 * contract is pinned by its own tests.
 */
export function mapRubiesResponseCodeStrict(
  code: string | undefined | null,
): "SUCCESS" | "PENDING" | "FAILED" {
  if (code == null || code === "") return "PENDING";
  return mapRubiesResponseCode(code);
}

/** Does this body actually look like an answer from Rubies, or is it gateway noise? */
function isRubiesResponseBody(data: unknown): data is RubiesApiResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as RubiesApiResponse).responseCode === "string"
  );
}

/**
 * Timeouts by call class. A single flat value is wrong at both ends: 30s of
 * silence mid-wizard is a bad experience, while aborting a fund transfer early
 * costs a 2-minute wait plus a status query for no reason.
 */
const INTERACTIVE_TIMEOUT_MS = 10_000; // user is watching: name enquiry, balance, bank list
const MONEY_TIMEOUT_MS = 60_000; // fund transfer, VAS purchase
const BACKGROUND_TIMEOUT_MS = 20_000; // status queries, reconciliation

interface RubiesApiResponse {
  responseCode?: string;
  responseMessage?: string;
  [key: string]: unknown;
}

/**
 * Client for the RubiesSme BaaS API (confirmed against the live OpenAPI spec
 * at api-sme-dev.rubies.ng/v3/api-docs/BAAS-API, plus a prior wallet
 * integration the user shared for a different product — patterns reused:
 * dry-run mode, "never trust a cached balance," structured
 * {responseCode,responseMessage} handling). This is the only path by which
 * money leaves a Kedu account — callers (TransferConfirmationService, Phase
 * 8) must have already run AllowanceService.evaluateSpend and gotten
 * explicit user confirmation before initiateTransfer is ever called.
 */
@Injectable()
export class RubiesService {
  private readonly logger = new Logger(RubiesService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private get baseUrl(): string {
    return this.config.get<string>(
      "RUBIES_BASE_URL",
      "https://api-sme-dev.rubies.ng",
    );
  }

  private get stage(): string {
    return this.config.get<string>("RUBIES_STAGE", "dev");
  }

  private get authHeader(): string {
    // Rubies' Authorization header holds the raw secret key itself — no "Bearer" prefix.
    return this.config.get<string>("RUBIES_API_KEY", "");
  }

  private get dryRun(): boolean {
    return this.config.get<string>("RUBIES_DRY_RUN", "false") === "true";
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T & RubiesApiResponse> {
    const url = `${this.baseUrl}/${this.stage}${path}`;
    type Response = T & RubiesApiResponse;
    try {
      const response = await firstValueFrom(
        this.http.post<Response>(url, body, {
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json",
          },
          timeout: options?.timeoutMs ?? INTERACTIVE_TIMEOUT_MS,
        }),
      );
      return response.data;
    } catch (err) {
      return this.handleRequestError<Response>(err, "POST", path);
    }
  }

  private async get<T>(
    path: string,
    options?: { timeoutMs?: number },
  ): Promise<T & RubiesApiResponse> {
    const url = `${this.baseUrl}/${this.stage}${path}`;
    type Response = T & RubiesApiResponse;
    try {
      const response = await firstValueFrom(
        this.http.get<Response>(url, {
          headers: { Authorization: this.authHeader },
          timeout: options?.timeoutMs ?? INTERACTIVE_TIMEOUT_MS,
        }),
      );
      return response.data;
    } catch (err) {
      return this.handleRequestError<Response>(err, "GET", path);
    }
  }

  /**
   * Decides whether an HTTP error carries an answer from Rubies or is just
   * noise, and it matters enormously which.
   *
   * Rubies returns a structured {responseCode, responseMessage} body on most 4xx
   * failures, and surfacing that is genuinely better than a bare HTTP error. But
   * the previous version returned `response.data` for *any* error with a body:
   * a 502 HTML page from a gateway, a 429, an auth error. Those have no
   * responseCode, and `mapRubiesResponseCode(undefined)` is FAILED — so a gateway
   * hiccup on a fund-transfer told the customer "nothing was deducted" when the
   * debit may well have landed, and marked the row terminal so nothing ever
   * rechecked it.
   *
   * Only a body that actually looks like a Rubies answer is treated as one.
   * Anything else throws, which leaves the transaction CONFIRMED for the
   * reconciliation job — the same path a PENDING response already takes.
   */
  private handleRequestError<Response extends RubiesApiResponse>(
    err: unknown,
    method: string,
    path: string,
  ): Response {
    const axiosErr = err as AxiosError<Response>;
    const data = axiosErr.response?.data;
    if (isRubiesResponseBody(data)) {
      return data as Response;
    }
    this.logger.error(
      `Rubies ${method} ${path} failed (status=${axiosErr.response?.status ?? "none"}): ${String(err)}`,
    );
    throw new Error("Could not reach Rubies. Please try again.");
  }

  /**
   * POST /{stage}/baas-wallet/create-wallet — provisions a persistent Rubies
   * wallet for a Kedu user. Exactly one of bvn/nin must be supplied (never
   * both, and never cac — Kedu users are individuals, not businesses).
   * Rubies requires >=90% name-similarity match against the BVN/NIN record;
   * a mismatch comes back as a normal failed response (e.g. responseCode
   * "25", "First name does not match"), not an unhandled exception, so
   * onboarding (Phase 4) can ask the user to retry.
   */
  async provisionAccount(kyc: {
    bvn?: string;
    nin?: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    dob?: string;
    email?: string;
  }): Promise<RubiesAccount> {
    const identifiers = [kyc.bvn, kyc.nin].filter((v) =>
      Boolean(v && v.trim()),
    );
    if (identifiers.length !== 1) {
      throw new Error("provisionAccount requires exactly one of bvn or nin.");
    }

    if (this.dryRun) {
      const suffix = kyc.phoneNumber
        .replace(/\D/g, "")
        .slice(-8)
        .padStart(8, "0");
      return {
        // Unique per call (not just per phone number) — a real per-wallet
        // accountId is unique per wallet Rubies creates, even when the same
        // person/number provisions more than once, which dry-run should
        // mirror rather than deterministically colliding on retry.
        accountId: `DRYRUN-ACCT-${randomUUID()}`,
        accountNumber: `77${suffix}`,
        accountName: `${kyc.firstName} ${kyc.lastName}`,
        bankCode: RUBIES_MFB_BANK_CODE,
      };
    }

    const response = await this.post<{
      customerId?: string;
      accountName?: string;
      accountNumber?: string;
    }>("/baas-wallet/create-wallet", {
      bvn: kyc.bvn,
      nin: kyc.nin,
      firstName: kyc.firstName,
      lastName: kyc.lastName,
      phoneNumber: kyc.phoneNumber,
      dob: kyc.dob,
      email: kyc.email,
    });

    if (
      response.responseCode !== "00" ||
      !response.accountNumber ||
      !response.customerId
    ) {
      throw new Error(response.responseMessage || "Wallet creation failed.");
    }

    // create-wallet's response never includes the wallet's own accountId —
    // only customerId (our organisation's ID, constant across every wallet)
    // — so fetch it with a follow-up call keyed by the accountNumber we just got.
    const { accountId } = await this.retrieveWalletDetails(
      response.accountNumber,
    );

    return {
      accountId,
      accountNumber: response.accountNumber,
      accountName: response.accountName ?? `${kyc.firstName} ${kyc.lastName}`,
      bankCode: RUBIES_MFB_BANK_CODE,
    };
  }

  /**
   * POST /{stage}/baas-wallet/retrieve-wallet-details — the only Rubies
   * endpoint that returns a wallet's own accountId (its internal per-wallet
   * database ID, e.g. "244623"), distinct from customerId (our
   * organisation's constant ID). Called once, right after create-wallet
   * succeeds, keyed by the accountNumber that call already returned.
   */
  async retrieveWalletDetails(
    accountNumber: string,
  ): Promise<{ accountId: string }> {
    if (this.dryRun) {
      return { accountId: `DRYRUN-ACCT-${randomUUID()}` };
    }

    const response = await this.post<{ accountId?: string }>(
      "/baas-wallet/retrieve-wallet-details",
      { accountNumber },
    );

    if (response.responseCode !== "00" || !response.accountId) {
      throw new Error(
        response.responseMessage || "Could not retrieve wallet details.",
      );
    }

    return { accountId: response.accountId };
  }

  /**
   * POST /{stage}/baas-transaction/name-enquiry — resolves a destination
   * account to its registered name. Required before the first transfer to a
   * new recipient (Kedu's tagging/confirmation step, PRD §6/§4a).
   */
  async nameEnquiry(params: {
    accountNumber: string;
    bankCode: string;
  }): Promise<RubiesNameEnquiryResult> {
    if (this.dryRun) {
      return { accountName: "Dry Run Recipient", bankName: "Access Bank" };
    }

    const response = await this.post<{
      accountName?: string;
      bankName?: string;
    }>("/baas-transaction/name-enquiry", {
      accountBankCode: params.bankCode,
      accountNumber: params.accountNumber,
    });

    if (response.responseCode !== "00" || !response.accountName) {
      throw new Error(
        response.responseMessage || "Could not resolve account name.",
      );
    }

    return {
      accountName: response.accountName,
      bankName: response.bankName ?? "",
    };
  }

  /**
   * POST /{stage}/baas-wallet/balance-enquiry — always a live check. Callers
   * must never substitute a locally-cached figure before authorizing a
   * transfer (a lesson carried over from the reference wallet integration).
   */
  async getBalance(accountNumber: string): Promise<number> {
    // A large fixed figure, not 0 — dry-run exists to simulate "this works," and 0
    // would make every dry-run transfer fail a caller's insufficient-funds check.
    if (this.dryRun) return 10_000_000;

    const response = await this.post<{ accountBalance?: string }>(
      "/baas-wallet/balance-enquiry",
      {
        accountNumber,
      },
    );

    if (response.responseCode !== "00") {
      throw new Error(
        response.responseMessage || "Could not retrieve balance.",
      );
    }

    return Number(response.accountBalance ?? 0);
  }

  /**
   * POST /{stage}/baas-transaction/fund-transfer — the ONLY path by which
   * money leaves a Kedu account. Callers must have already run
   * AllowanceService.evaluateSpend and gotten explicit user confirmation
   * before this is ever called (TransferConfirmationService, Phase 8).
   * Server-to-server API-key auth bypasses transactionPin/otp entirely —
   * those only apply to user-session/JWT-based calls per Rubies' docs; the
   * WhatsApp button-confirm *is* the authorization step here, there is no
   * separate Rubies PIN collected from the user.
   */
  async initiateTransfer(params: {
    fromAccountNumber: string;
    fromAccountName: string;
    toAccountNumber: string;
    toBankCode: string;
    toAccountName: string;
    amount: number;
    narration: string;
    idempotencyKey: string;
  }): Promise<RubiesTransferResult> {
    if (this.dryRun) {
      return {
        reference: params.idempotencyKey,
        status: "SUCCESS",
        responseCode: "00",
      };
    }

    const response = await this.post<{
      reference?: string;
      sessionId?: string;
    }>("/baas-transaction/fund-transfer", {
      amount: String(params.amount),
      bankCode: params.toBankCode,
      creditAccountNumber: params.toAccountNumber,
      creditAccountName: params.toAccountName,
      debitAccountNumber: params.fromAccountNumber,
      debitAccountName: params.fromAccountName,
      narration: params.narration,
      reference: params.idempotencyKey,
    }, { timeoutMs: MONEY_TIMEOUT_MS });

    return {
      reference: response.reference ?? params.idempotencyKey,
      status: mapRubiesResponseCodeStrict(response.responseCode),
      responseCode: response.responseCode ?? "",
      responseMessage: response.responseMessage,
      sessionId: response.sessionId,
    };
  }

  /**
   * POST /{stage}/baas-transaction/tsq — confirms the true final status of a
   * transfer that came back PENDING (09/90/99), and is also the
   * reconciliation fallback for a Rubies webhook that never arrives (Phase 8
   * / TransferConfirmationService polls this for anything stuck pending).
   * Per Rubies' own docs, 09/90 from tsq itself still means "not yet known"
   * — poll again later, never assume success just because tsq answered.
   */
  async queryTransferStatus(reference: string): Promise<RubiesTransferResult> {
    if (this.dryRun) {
      return { reference, status: "SUCCESS", responseCode: "00" };
    }

    const response = await this.post<{ paymentReference?: string }>(
      "/baas-transaction/tsq",
      {
        reference,
      },
      { timeoutMs: BACKGROUND_TIMEOUT_MS },
    );

    return {
      reference,
      status: mapRubiesResponseCodeStrict(response.responseCode),
      responseCode: response.responseCode ?? "",
      responseMessage: response.responseMessage,
    };
  }

  /** POST /{stage}/baas-transaction/bank-list — used to resolve a bank name to its CBN code during recipient tagging. */
  async listBanks(): Promise<RubiesBank[]> {
    if (this.dryRun) {
      return [
        { bankCode: "000005", bankName: "Access Bank" },
        { bankCode: "000004", bankName: "GTBank" },
        { bankCode: RUBIES_MFB_BANK_CODE, bankName: "Rubies MFB" },
      ];
    }

    // Degrades to an empty list rather than throwing. This is called unwrapped
    // from five places in the transfer wizard, and a throw there reaches the
    // controller, which logs it and marks the message FAILED — so the user gets
    // no reply at all. An empty list produces "couldn't find that bank", which
    // is a worse answer than the truth but a far better outcome than silence.
    // No money is at stake on this path.
    try {
      const response = await this.post<{
        data?: { bankCode?: string; bankName?: string }[];
      }>("/baas-transaction/bank-list", {});

      const rows = Array.isArray(response.data) ? response.data : [];
      return rows.map((r) => ({
        bankCode: r.bankCode ?? "",
        bankName: r.bankName ?? "",
      }));
    } catch (err) {
      this.logger.error(`Rubies bank-list unavailable: ${String(err)}`);
      return [];
    }
  }

  /**
   * POST /{stage}/baas-vas/purchase — airtime/data/bills. Debits accountNumber
   * (user wallet). Server-to-server API key auth bypasses Rubies PIN/OTP.
   */
  async purchaseVas(params: {
    accountNumber: string;
    billerCustomerId: string;
    productCode: string;
    amount: number;
    requestReference: string;
    customerName?: string;
  }): Promise<RubiesVasPurchaseResult> {
    if (this.dryRun) {
      return {
        requestReference: params.requestReference,
        reference: params.requestReference,
        status: "SUCCESS",
        responseCode: "00",
        vendorToken: "1234-5678-9012-3456-7890",
      };
    }

    const response = await this.post<{
      requestReference?: string;
      reference?: string;
      token?: string;
      rechargeToken?: string;
      vendorToken?: string;
      extraData?: { token?: string; rechargeToken?: string };
    }>("/baas-vas/purchase", {
      reference: params.requestReference,
      accountNumber: params.accountNumber,
      billerCustomerId: params.billerCustomerId,
      productCode: params.productCode,
      amount: `${params.amount}.0`,
      customerName: params.customerName,
    }, { timeoutMs: MONEY_TIMEOUT_MS });

    return {
      requestReference:
        response.requestReference ?? params.requestReference,
      reference: response.reference ?? params.requestReference,
      status: mapRubiesResponseCodeStrict(response.responseCode),
      responseCode: response.responseCode ?? "",
      responseMessage: response.responseMessage,
      vendorToken: extractVasToken(response),
    };
  }

  /**
   * POST /{stage}/baas-vas/customerEnquiry — meter / customer lookup before
   * electricity purchase (billerValidation: YES billers).
   */
  async validateVasCustomer(params: {
    billerCode: string;
    productCode: string;
    billerCustomerId: string;
  }): Promise<RubiesVasCustomerLookupResult> {
    if (this.dryRun) {
      return {
        ok: true,
        customerName: "DRY RUN CUSTOMER",
        responseCode: "00",
      };
    }

    // Same reasoning as listBanks: a meter lookup is an interactive, non-money
    // step, and "couldn't verify that meter" beats no reply at all.
    let response: {
      customerName?: string;
      name?: string;
      data?: { customerName?: string; name?: string };
    } & RubiesApiResponse;
    try {
      response = await this.post<{
        customerName?: string;
        name?: string;
        data?: { customerName?: string; name?: string };
      }>("/baas-vas/customerEnquiry", {
        billerCode: params.billerCode,
        productCode: params.productCode,
        billerCustomerId: params.billerCustomerId,
      });
    } catch (err) {
      this.logger.error(`Rubies customerEnquiry unavailable: ${String(err)}`);
      return {
        ok: false,
        responseCode: "",
        responseMessage: "Customer lookup is unavailable right now.",
      };
    }

    const customerName =
      response.customerName ??
      response.name ??
      response.data?.customerName ??
      response.data?.name;

    const ok =
      response.responseCode === "00" &&
      typeof customerName === "string" &&
      customerName.trim().length > 0;

    return {
      ok,
      customerName: customerName?.trim(),
      responseCode: response.responseCode ?? "",
      responseMessage: response.responseMessage,
    };
  }

  /** GET /{stage}/baas-vas/transaction-query/{reference} — use requestReference. */
  async queryVasTransaction(
    requestReference: string,
  ): Promise<RubiesVasPurchaseResult> {
    if (this.dryRun) {
      return {
        requestReference,
        reference: requestReference,
        status: "SUCCESS",
        responseCode: "00",
      };
    }

    const response = await this.get<{
      requestReference?: string;
      reference?: string;
      token?: string;
      rechargeToken?: string;
      vendorToken?: string;
      extraData?: { token?: string; rechargeToken?: string };
    }>(`/baas-vas/transaction-query/${encodeURIComponent(requestReference)}`, {
      timeoutMs: BACKGROUND_TIMEOUT_MS,
    });

    return {
      requestReference,
      reference: response.reference ?? requestReference,
      status: mapRubiesResponseCodeStrict(response.responseCode),
      responseCode: response.responseCode ?? "",
      responseMessage: response.responseMessage,
      vendorToken: extractVasToken(response),
    };
  }
}

function extractVasToken(payload: {
  token?: string;
  rechargeToken?: string;
  vendorToken?: string;
  extraData?: { token?: string; rechargeToken?: string };
}): string | undefined {
  return (
    payload.vendorToken ??
    payload.token ??
    payload.rechargeToken ??
    payload.extraData?.token ??
    payload.extraData?.rechargeToken
  );
}
