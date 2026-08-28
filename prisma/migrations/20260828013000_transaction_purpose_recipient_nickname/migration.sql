-- AlterTable
ALTER TABLE "Recipient" ADD COLUMN "nickname" TEXT,
ADD COLUMN "lastUsedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "purposeLabel" "RecipientLabel";

-- CreateIndex
CREATE INDEX "Recipient_userId_nickname_idx" ON "Recipient"("userId", "nickname");
