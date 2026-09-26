import { Injectable } from "@nestjs/common";
import { RubiesBank, RubiesService } from "../../rubies/rubies.service";

const CACHE_MS = 6 * 60 * 60_000;
/** After Rubies answers with nothing, how long to answer nothing without asking again. */
const EMPTY_BACKOFF_MS = 60_000;

/**
 * The bank list for the app, held in memory. Rubies' list changes rarely, and
 * the history screen needs names for every recipient's bank code.
 *
 * RubiesService.listBanks answers [] rather than throwing when Rubies is
 * unreachable. That is never cached, or the app would show no banks for six
 * hours; instead the next minute answers [] straight away, so a Rubies outage
 * does not make every history page wait on a timeout.
 */
@Injectable()
export class BankDirectoryService {
  private banks: RubiesBank[] = [];
  private fetchedAt = 0;
  private emptyAt = -Infinity;
  private inFlight: Promise<RubiesBank[]> | null = null;

  constructor(private readonly rubies: RubiesService) {}

  async list(now: number = Date.now()): Promise<RubiesBank[]> {
    if (this.banks.length > 0 && now - this.fetchedAt < CACHE_MS) {
      return this.banks;
    }
    if (now - this.emptyAt < EMPTY_BACKOFF_MS) return this.banks;
    this.inFlight ??= this.refresh(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Bank code to name, from whatever list is available; empty if none. */
  async names(): Promise<Map<string, string>> {
    const banks = await this.list();
    return new Map(banks.map((b) => [b.bankCode, b.bankName]));
  }

  private async refresh(now: number): Promise<RubiesBank[]> {
    const banks = (await this.rubies.listBanks()).filter(
      (b) => b.bankCode && b.bankName,
    );
    if (banks.length === 0) {
      this.emptyAt = now;
      // A stale list beats none while Rubies is down.
      return this.banks;
    }
    this.banks = [...banks].sort((a, b) =>
      a.bankName.localeCompare(b.bankName),
    );
    this.fetchedAt = now;
    return this.banks;
  }
}
