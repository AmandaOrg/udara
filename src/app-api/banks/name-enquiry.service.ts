import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { RubiesService } from "../../rubies/rubies.service";

export const LOOKUPS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

/**
 * Who owns an account number, so the app can show it before a send.
 *
 * This is also a way to find out who owns any account, so it is limited per
 * user in the database: the in-memory throttler resets on every token refresh
 * and every restart. It needs an opened account, which needs a verified
 * identity, so a phone that has only signed up cannot use it at all.
 */
@Injectable()
export class NameEnquiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
  ) {}

  async lookup(
    userId: string,
    accountNumber: string,
    bankCode: string,
    now: Date = new Date(),
  ): Promise<{ accountName: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { rubiesAccountNumber: true },
    });
    if (!user.rubiesAccountNumber) {
      throw new ConflictException({ error: "no_account" });
    }

    await this.claim(userId, now);

    try {
      const result = await this.rubies.nameEnquiry({ accountNumber, bankCode });
      return { accountName: result.accountName };
    } catch {
      // Rubies does not say whether the account is missing or it is down.
      throw new UnprocessableEntityException({ error: "not_resolved" });
    }
  }

  /**
   * Record the lookup, then count. Recording first means concurrent calls
   * each count themselves, so a burst cannot all see the count below the
   * limit. A refused lookup takes its row back out, so waiting works.
   */
  private async claim(userId: string, now: Date): Promise<void> {
    const since = new Date(now.getTime() - HOUR_MS);
    const row = await this.prisma.nameEnquiryLog.create({
      data: { userId, createdAt: now },
      select: { id: true },
    });
    const count = await this.prisma.nameEnquiryLog.count({
      where: { userId, createdAt: { gt: since } },
    });
    await this.prisma.nameEnquiryLog.deleteMany({
      where: { userId, createdAt: { lte: since } },
    });
    if (count > LOOKUPS_PER_HOUR) {
      await this.prisma.nameEnquiryLog.delete({ where: { id: row.id } });
      throw new HttpException(
        { error: "too_many_lookups" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
