-- CreateEnum
CREATE TYPE "TransferDraftStep" AS ENUM ('AWAITING_AMOUNT', 'AWAITING_ACCOUNT_NUMBER', 'AWAITING_BANK_SELECTION', 'AWAITING_LABEL_SELECTION');

-- CreateEnum
CREATE TYPE "TransferDraftStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TransferDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" "TransferDraftStep" NOT NULL,
    "status" "TransferDraftStatus" NOT NULL DEFAULT 'ACTIVE',
    "amount" DECIMAL(14,2),
    "accountNumber" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "resolvedName" TEXT,
    "isNewRecipient" BOOLEAN NOT NULL DEFAULT false,
    "label" "RecipientLabel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferDraft_userId_status_idx" ON "TransferDraft"("userId", "status");

-- AddForeignKey
ALTER TABLE "TransferDraft" ADD CONSTRAINT "TransferDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
