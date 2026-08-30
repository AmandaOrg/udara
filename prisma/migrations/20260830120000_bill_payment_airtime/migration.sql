-- CreateEnum
CREATE TYPE "BillPaymentCategory" AS ENUM ('AIRTIME');

-- CreateEnum
CREATE TYPE "BillPaymentDraftStep" AS ENUM ('AWAITING_TELCO', 'AWAITING_AMOUNT', 'AWAITING_MSISDN');

-- CreateEnum
CREATE TYPE "BillPaymentDraftStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillPaymentStatus" AS ENUM ('PENDING_CONFIRMATION', 'PENDING_PIN', 'CONFIRMED', 'EXECUTED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "RubiesWebhookEventType" ADD VALUE 'BILL_PAYMENT';

-- CreateTable
CREATE TABLE "BillPaymentDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "BillPaymentCategory" NOT NULL DEFAULT 'AIRTIME',
    "step" "BillPaymentDraftStep" NOT NULL,
    "status" "BillPaymentDraftStatus" NOT NULL DEFAULT 'ACTIVE',
    "billerCode" TEXT,
    "productCode" TEXT,
    "telcoLabel" TEXT,
    "amount" DECIMAL(14,2),
    "msisdn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillPaymentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "BillPaymentCategory" NOT NULL DEFAULT 'AIRTIME',
    "billerCode" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "telcoLabel" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "type" "TransactionType" NOT NULL DEFAULT 'NORMAL',
    "status" "BillPaymentStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rubiesReference" TEXT,
    "requestReference" TEXT,
    "idempotencyKey" TEXT,
    "dailyAllowanceId" TEXT,
    "appliedToAllowanceAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillPaymentDraft_userId_status_idx" ON "BillPaymentDraft"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillPayment_requestReference_key" ON "BillPayment"("requestReference");

-- CreateIndex
CREATE UNIQUE INDEX "BillPayment_idempotencyKey_key" ON "BillPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillPayment_userId_status_idx" ON "BillPayment"("userId", "status");

-- AlterTable
ALTER TABLE "PinChallenge" ADD COLUMN "billPaymentId" TEXT;

-- AddForeignKey
ALTER TABLE "BillPaymentDraft" ADD CONSTRAINT "BillPaymentDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_dailyAllowanceId_fkey" FOREIGN KEY ("dailyAllowanceId") REFERENCES "DailyAllowance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinChallenge" ADD CONSTRAINT "PinChallenge_billPaymentId_fkey" FOREIGN KEY ("billPaymentId") REFERENCES "BillPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
