import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RecipientLabel } from '@prisma/client';

@Injectable()
export class TaggingService {
  constructor(private readonly prisma: PrismaService) {}

  async findRecipient(userId: string, accountNumber: string, bankCode: string) {
    return this.prisma.recipient.findUnique({
      where: { userId_accountNumber_bankCode: { userId, accountNumber, bankCode } },
    });
  }

  /** Called the first time a user sends to a new recipient — PRD #6. */
  async tagRecipient(params: {
    userId: string;
    accountNumber: string;
    bankCode: string;
    accountName?: string;
    label: RecipientLabel;
  }) {
    return this.prisma.recipient.create({
      data: {
        userId: params.userId,
        accountNumber: params.accountNumber,
        bankCode: params.bankCode,
        accountName: params.accountName,
        label: params.label,
      },
    });
  }
}
