import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Recipient, RecipientLabel } from "@prisma/client";
import {
  findAmbiguousBeneficiaryMatches,
  matchSavedBeneficiaries,
} from "./beneficiary-match.util";

@Injectable()
export class TaggingService {
  constructor(private readonly prisma: PrismaService) {}

  async findRecipient(userId: string, accountNumber: string, bankCode: string) {
    return this.prisma.recipient.findUnique({
      where: {
        userId_accountNumber_bankCode: { userId, accountNumber, bankCode },
      },
    });
  }

  async listRecipientsForUser(userId: string): Promise<Recipient[]> {
    return this.prisma.recipient.findMany({
      where: { userId },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  /** Resolve a saved beneficiary by nickname or unique account-name match. */
  async matchBeneficiaryByName(
    userId: string,
    query: string,
  ): Promise<Recipient | null> {
    const recipients = await this.listRecipientsForUser(userId);
    const matches = matchSavedBeneficiaries(recipients, query);
    return matches.length === 1 ? matches[0]! : null;
  }

  async findAmbiguousBeneficiaryMatches(
    userId: string,
    query: string,
  ): Promise<Recipient[]> {
    const recipients = await this.listRecipientsForUser(userId);
    return findAmbiguousBeneficiaryMatches(recipients, query);
  }

  /** Called the first time a user sends to a new recipient — PRD #6. */
  async tagRecipient(params: {
    userId: string;
    accountNumber: string;
    bankCode: string;
    accountName?: string;
    label: RecipientLabel;
    nickname?: string;
  }) {
    return this.prisma.recipient.create({
      data: {
        userId: params.userId,
        accountNumber: params.accountNumber,
        bankCode: params.bankCode,
        accountName: params.accountName,
        label: params.label,
        nickname: params.nickname,
        lastUsedAt: new Date(),
      },
    });
  }

  async touchRecipientUsed(
    recipientId: string,
    params?: { nickname?: string },
  ): Promise<void> {
    const data: { lastUsedAt: Date; nickname?: string } = {
      lastUsedAt: new Date(),
    };
    if (params?.nickname?.trim()) {
      data.nickname = params.nickname.trim().slice(0, 50);
    }
    await this.prisma.recipient.update({
      where: { id: recipientId },
      data,
    });
  }
}
