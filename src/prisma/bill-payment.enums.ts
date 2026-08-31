/**
 * Mirrors `prisma/schema.prisma` bill-payment enums.
 *
 * Imported by units that the editor's `@prisma/client` types lag on
 * (BillPayment* is generated, but the language service often keeps a
 * pre-bills client). Runtime values are the same strings Prisma stores.
 * Keep this file in lockstep with the schema enums.
 */
export const BillPaymentCategory = {
  AIRTIME: "AIRTIME",
  DATA: "DATA",
  ELECTRICITY: "ELECTRICITY",
} as const;
export type BillPaymentCategory =
  (typeof BillPaymentCategory)[keyof typeof BillPaymentCategory];

export const BillPaymentDraftStatus = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type BillPaymentDraftStatus =
  (typeof BillPaymentDraftStatus)[keyof typeof BillPaymentDraftStatus];

export const BillPaymentDraftStep = {
  AWAITING_TELCO: "AWAITING_TELCO",
  AWAITING_AMOUNT: "AWAITING_AMOUNT",
  AWAITING_MSISDN: "AWAITING_MSISDN",
  AWAITING_PRODUCT: "AWAITING_PRODUCT",
  AWAITING_METER: "AWAITING_METER",
  AWAITING_DISCO: "AWAITING_DISCO",
} as const;
export type BillPaymentDraftStep =
  (typeof BillPaymentDraftStep)[keyof typeof BillPaymentDraftStep];

export const BillPaymentStatus = {
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  PENDING_PIN: "PENDING_PIN",
  CONFIRMED: "CONFIRMED",
  EXECUTED: "EXECUTED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type BillPaymentStatus =
  (typeof BillPaymentStatus)[keyof typeof BillPaymentStatus];
