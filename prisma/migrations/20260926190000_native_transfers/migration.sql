-- CreateEnum
CREATE TYPE "PaymentSurface" AS ENUM ('CHAT', 'NATIVE');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "clientRequestKey" TEXT,
ADD COLUMN     "originSurface" "PaymentSurface" NOT NULL DEFAULT 'CHAT';

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_clientRequestKey_key" ON "Transaction"("userId", "clientRequestKey");

