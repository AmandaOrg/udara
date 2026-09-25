-- Identity moves from the WhatsApp channel to the phone number: an app-only
-- user has a phone number and no WhatsApp conversation.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastAppActiveAt" TIMESTAMP(3),
ADD COLUMN     "phoneNumber" TEXT;

-- Every existing user arrived through WhatsApp, whose sender id is already
-- the canonical form (international digits, no "+").
UPDATE "User" SET "phoneNumber" = "whatsappNumber";

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "phoneNumber" SET NOT NULL,
ALTER COLUMN "whatsappNumber" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
