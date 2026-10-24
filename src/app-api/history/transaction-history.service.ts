import { Injectable } from "@nestjs/common";
import {
  BillPaymentCategory,
  BillPaymentStatus,
  TransactionStatus,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { BankDirectoryService } from "../banks/bank-directory.service";
import type {
  HistoryItemView,
  HistoryPageView,
  HistoryStatus,
} from "./history.view";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Only what the user committed to. Quotes and cancellations are not history. */
const TRANSFER_STATUSES = [
  TransactionStatus.CONFIRMED,
  TransactionStatus.EXECUTED,
  TransactionStatus.FAILED,
];
const BILL_STATUSES = [
  BillPaymentStatus.CONFIRMED,
  BillPaymentStatus.EXECUTED,
  BillPaymentStatus.FAILED,
];

const STATUS: Record<string, HistoryStatus> = {
  CONFIRMED: "processing",
  EXECUTED: "successful",
  FAILED: "failed",
};

export interface HistoryCursor {
  at: Date;
  id: string;
}

const CURSOR =
  /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.at.getTime()}.${cursor.id}`).toString(
    "base64url",
  );
}

/** Null for anything that is not a cursor this service produced. */
export function decodeCursor(raw: string): HistoryCursor | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw)) return null;
  const match = CURSOR.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!match) return null;
  return { at: new Date(Number(match[1])), id: match[2] };
}

/** Strictly after the cursor in (time desc, id desc) order. */
function after(field: "createdAt" | "creditedAt", cursor?: HistoryCursor) {
  if (!cursor) return {};
  return {
    OR: [
      { [field]: { lt: cursor.at } },
      { [field]: cursor.at, id: { lt: cursor.id } },
    ],
  };
}

function byNewest(a: HistoryItemView, b: HistoryItemView): number {
  if (a.occurredAt !== b.occurredAt)
    return a.occurredAt < b.occurredAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function billTitle(category: BillPaymentCategory, provider: string): string {
  switch (category) {
    case BillPaymentCategory.AIRTIME:
      return `${provider} airtime`;
    case BillPaymentCategory.DATA:
      return `${provider} data`;
    default:
      return provider;
  }
}

/**
 * One history of transfers, bill purchases and money received, newest first,
 * for one user.
 *
 * Each source is read in the same (time desc, id desc) order, at most one
 * page past the cursor, then merged and cut to a page. The page is always
 * among those rows, so nothing is skipped; the cursor is the last row's
 * (time, id), so nothing repeats, and rows arriving meanwhile land before it.
 * Ids are UUIDs, unique across the three tables, so the order is total.
 */
@Injectable()
export class TransactionHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banks: BankDirectoryService,
  ) {}

  async page(
    userId: string,
    cursor?: HistoryCursor,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<HistoryPageView> {
    const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);

    const [transfers, bills, credits] = await Promise.all([
      this.prisma.transaction.findMany({
        where: {
          userId,
          status: { in: TRANSFER_STATUSES },
          ...after("createdAt", cursor),
        },
        include: { recipient: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
      }),
      this.prisma.billPayment.findMany({
        where: {
          userId,
          status: { in: BILL_STATUSES },
          ...after("createdAt", cursor),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
      }),
      this.prisma.incomingCredit.findMany({
        where: { userId, ...after("creditedAt", cursor) },
        orderBy: [{ creditedAt: "desc" }, { id: "desc" }],
        take,
      }),
    ]);

    const bankNames =
      transfers.length > 0
        ? await this.banks.names()
        : new Map<string, string>();

    const items: HistoryItemView[] = [
      ...transfers.map((t): HistoryItemView => {
        const r = t.recipient;
        return {
          id: t.id,
          kind: "transfer",
          direction: "out",
          status: STATUS[t.status],
          amount: Number(t.amount),
          fee: Number(t.feeAmount),
          spendType: t.type,
          occurredAt: t.createdAt.toISOString(),
          title: r.nickname ?? r.accountName ?? r.accountNumber,
          transfer: {
            accountName: r.accountName,
            nickname: r.nickname,
            accountNumber: r.accountNumber,
            bankCode: r.bankCode,
            bankName: bankNames.get(r.bankCode) ?? null,
            purpose: t.purposeLabel ?? r.label,
          },
        };
      }),
      ...bills.map((b): HistoryItemView => ({
        id: b.id,
        kind: "bill",
        direction: "out",
        status: STATUS[b.status],
        amount: Number(b.amount),
        fee: Number(b.feeAmount),
        spendType: b.type,
        occurredAt: b.createdAt.toISOString(),
        title: billTitle(b.category, b.telcoLabel),
        bill: {
          category: b.category,
          provider: b.telcoLabel,
          product: b.productLabel,
          target: b.msisdn,
          customerName: b.customerName,
          token: b.status === BillPaymentStatus.EXECUTED ? b.vendorToken : null,
        },
      })),
      ...credits.map((c): HistoryItemView => ({
        id: c.id,
        kind: "credit",
        direction: "in",
        status: "successful",
        amount: Number(c.amount),
        fee: 0,
        spendType: null,
        occurredAt: c.creditedAt.toISOString(),
        title: c.sourceNarration ?? "Money received",
        credit: { narration: c.sourceNarration },
      })),
    ]
      .sort(byNewest)
      .slice(0, take);

    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        items.length === take && last
          ? encodeCursor({ at: new Date(last.occurredAt), id: last.id })
          : null,
    };
  }
}
