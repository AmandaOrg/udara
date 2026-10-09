-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailType" ADD VALUE 'EMAIL_VERIFICATION';
ALTER TYPE "EmailType" ADD VALUE 'ACCOUNT_CLOSURE_REQUESTED';
ALTER TYPE "EmailType" ADD VALUE 'ACCOUNT_CLOSED';

-- AlterEnum
ALTER TYPE "SettingsChangeStatus" ADD VALUE 'WITHDRAWN';

-- AlterEnum
ALTER TYPE "SettingsChangeType" ADD VALUE 'ACCOUNT_DELETION';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedPhoneNumber" TEXT,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHmac" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerification_userId_createdAt_idx" ON "EmailVerification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

