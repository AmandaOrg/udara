-- AlterEnum
ALTER TYPE "BillPaymentCategory" ADD VALUE 'DATA';
ALTER TYPE "BillPaymentCategory" ADD VALUE 'ELECTRICITY';

-- AlterEnum
ALTER TYPE "BillPaymentDraftStep" ADD VALUE 'AWAITING_PRODUCT';
ALTER TYPE "BillPaymentDraftStep" ADD VALUE 'AWAITING_METER';
ALTER TYPE "BillPaymentDraftStep" ADD VALUE 'AWAITING_DISCO';

-- AlterTable
ALTER TABLE "BillPaymentDraft" ADD COLUMN "productLabel" TEXT;
ALTER TABLE "BillPaymentDraft" ADD COLUMN "customerName" TEXT;

-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN "productLabel" TEXT;
ALTER TABLE "BillPayment" ADD COLUMN "customerName" TEXT;
ALTER TABLE "BillPayment" ADD COLUMN "vendorToken" TEXT;
