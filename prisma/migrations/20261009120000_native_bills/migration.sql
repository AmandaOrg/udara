-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "clientRequestKey" TEXT,
ADD COLUMN     "originSurface" "PaymentSurface" NOT NULL DEFAULT 'CHAT';

-- CreateIndex
CREATE UNIQUE INDEX "BillPayment_userId_clientRequestKey_key" ON "BillPayment"("userId", "clientRequestKey");

