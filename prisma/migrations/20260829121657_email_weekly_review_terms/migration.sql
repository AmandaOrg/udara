-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('MONEY_IN', 'MONEY_OUT', 'WINDOW_OPEN', 'WEEKLY_SUMMARY', 'MONTHLY_SUMMARY');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WeeklyReviewStatus" AS ENUM ('SENT', 'AWAITING_LIMIT', 'COMPLETED');

-- AlterEnum
ALTER TYPE "NudgeType" ADD VALUE 'WEEKLY_REVIEW';

-- AlterEnum
ALTER TYPE "OnboardingStage" ADD VALUE 'TERMS_CONSENT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailyLimitOverride" DECIMAL(14,2),
ADD COLUMN     "dailyLimitOverrideWeekStart" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "status" "WeeklyReviewStatus" NOT NULL DEFAULT 'SENT',
    "totalSpent" DECIMAL(14,2) NOT NULL,
    "newDailyLimit" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "WeeklyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailLog_dedupeKey_key" ON "EmailLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailLog_userId_type_createdAt_idx" ON "EmailLog"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "WeeklyReview_userId_status_idx" ON "WeeklyReview"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyReview_userId_weekStartDate_key" ON "WeeklyReview"("userId", "weekStartDate");

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyReview" ADD CONSTRAINT "WeeklyReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
