-- CreateEnum
CREATE TYPE "PinChallengePurpose" AS ENUM ('SETUP', 'TRANSFER_AUTH');

-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'PENDING_PIN';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pinHash" TEXT,
ADD COLUMN     "pinLockedUntil" TIMESTAMP(3),
ADD COLUMN     "pinSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PinChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flowToken" TEXT NOT NULL,
    "purpose" "PinChallengePurpose" NOT NULL,
    "transactionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PinChallenge_flowToken_key" ON "PinChallenge"("flowToken");

-- CreateIndex
CREATE INDEX "PinChallenge_userId_purpose_idx" ON "PinChallenge"("userId", "purpose");

-- AddForeignKey
ALTER TABLE "PinChallenge" ADD CONSTRAINT "PinChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
