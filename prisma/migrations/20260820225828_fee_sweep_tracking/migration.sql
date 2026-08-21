-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "feeSweepReference" TEXT,
ADD COLUMN     "feeSweptAt" TIMESTAMP(3);
