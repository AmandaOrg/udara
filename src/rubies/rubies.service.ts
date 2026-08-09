import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";

export interface RubiesAccount {
  accountId: string;
  accountNumber: string;
  bankCode: string;
}

export interface RubiesTransferResult {
  reference: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
}

/**
 * Thin wrapper around Rubies Microfinance's API. Since this is the piece
 * you've already built production-grade before, this is left as a typed
 * interface + TODOs rather than reimplemented — swap in your existing
 * client/auth pattern here.
 */
@Injectable()
export class RubiesService {
  private readonly baseUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>("RUBIES_BASE_URL", "");
  }

  async provisionAccount(_userId: string): Promise<RubiesAccount> {
    // TODO (Phase 7): KYC/BVN-or-NIN payload via baas-wallet/create-wallet, dev vs prod stage switch.
    throw new Error("Not implemented");
  }

  async getBalance(_accountId: string): Promise<number> {
    // TODO (Phase 7): baas-wallet/balance-enquiry.
    throw new Error("Not implemented");
  }

  async initiateTransfer(_params: {
    fromAccountId: string;
    toAccountNumber: string;
    toBankCode: string;
    amount: number;
    narration: string;
  }): Promise<RubiesTransferResult> {
    // TODO (Phase 7): baas-transaction/fund-transfer. This is the only path by which
    // money leaves a Kedu account — callers must have already run
    // AllowanceService.evaluateSpend and gotten explicit user confirmation before
    // this is ever called.
    throw new Error("Not implemented");
  }
}
