import { PaymentSurface, Prisma, TransactionType } from "@prisma/client";
import type { AppPrincipal } from "../app-auth/session.service";
import { runInChannel } from "../messaging/channel-context";
import { formatSpendFeeLine } from "../whatsapp/transfer-confirmation.service";
import { TransactionType as LocalTransactionType } from "../common/enums/transaction-type.enum";
import type { PaymentStatus } from "./payment.view";

/** The `Idempotency-Key` header: the app's own id for one payment attempt. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

// Transaction and BillPayment share these status names.
const STATUS: Record<string, PaymentStatus> = {
  PENDING_CONFIRMATION: "awaiting_confirmation",
  PENDING_PIN: "awaiting_pin",
  CONFIRMED: "processing",
  EXECUTED: "successful",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export function paymentStatus(status: string): PaymentStatus {
  return STATUS[status];
}

/** Naira for a screen: never negative, rounded to kobo. */
export function naira(amount: number): number {
  return Math.max(0, Math.round(amount * 100) / 100);
}

/**
 * Runs a native money call in the app's channel context, so a quote records
 * originChannel APP, the new-device cap applies to the PIN, and a result known
 * during the request lands in the app chat without a push.
 */
export function inApp<T>(
  principal: AppPrincipal,
  fn: () => Promise<T>,
): Promise<T> {
  return runInChannel({ channel: "app", deviceId: principal.deviceId }, fn);
}

/** Two first requests under one Idempotency-Key: the loser hits the index. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * The fee line the WhatsApp card shows. The quote's waiver is not stored; a
 * spend that is not NORMAL and carries no fee is exactly a waived one.
 */
export function feeNote(type: TransactionType, fee: number): string | null {
  return formatSpendFeeLine(
    type as unknown as LocalTransactionType,
    fee,
    type !== TransactionType.NORMAL && fee === 0,
  );
}

export function surfaceOf(surface: PaymentSurface): "native" | "chat" {
  return surface === PaymentSurface.NATIVE ? "native" : "chat";
}
