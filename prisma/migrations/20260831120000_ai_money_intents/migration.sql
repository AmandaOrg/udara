-- AlterEnum
ALTER TYPE "TransferDraftStep" ADD VALUE 'AWAITING_PURPOSE_NOTE';

-- AlterTable
ALTER TABLE "TransferDraft" ADD COLUMN "purposeNote" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "purposeNote" TEXT;
