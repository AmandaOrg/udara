-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "feeSweepAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "feeSweepLastTryAt" TIMESTAMP(3);
