-- CreateEnum
CREATE TYPE "SavingsBucketType" AS ENUM ('SPEND_SAVE', 'AUTO_SAVE', 'HARDLOCK', 'GOAL_BASED');

-- CreateEnum
CREATE TYPE "SavingsPlanStatus" AS ENUM ('ACTIVE', 'PAUSED', 'LOCKED', 'MATURED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SavingsMovementDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "SavingsMovementStatus" AS ENUM ('PENDING', 'SUCCESSFUL', 'FAILED');

-- CreateTable
CREATE TABLE "SavingsBucket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SavingsBucketType" NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsPlan" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "emoji" TEXT,
    "color" TEXT,
    "colorBg" TEXT,
    "currentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
    "targetAmount" DECIMAL(14,2),
    "rateLabel" TEXT,
    "annualRate" DECIMAL(5,4),
    "unlockDate" TIMESTAMP(3),
    "cadence" TEXT,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "ruleConfig" JSONB,
    "status" "SavingsPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "planId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "direction" "SavingsMovementDirection" NOT NULL,
    "status" "SavingsMovementStatus" NOT NULL DEFAULT 'SUCCESSFUL',
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavingsBucket_userId_idx" ON "SavingsBucket"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsBucket_userId_type_key" ON "SavingsBucket"("userId", "type");

-- CreateIndex
CREATE INDEX "SavingsPlan_userId_bucketId_idx" ON "SavingsPlan"("userId", "bucketId");

-- CreateIndex
CREATE INDEX "SavingsPlan_status_unlockDate_idx" ON "SavingsPlan"("status", "unlockDate");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsTransaction_reference_key" ON "SavingsTransaction"("reference");

-- CreateIndex
CREATE INDEX "SavingsTransaction_userId_bucketId_idx" ON "SavingsTransaction"("userId", "bucketId");

-- CreateIndex
CREATE INDEX "SavingsTransaction_userId_occurredAt_idx" ON "SavingsTransaction"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "SavingsBucket" ADD CONSTRAINT "SavingsBucket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsPlan" ADD CONSTRAINT "SavingsPlan_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "SavingsBucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsPlan" ADD CONSTRAINT "SavingsPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsTransaction" ADD CONSTRAINT "SavingsTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsTransaction" ADD CONSTRAINT "SavingsTransaction_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "SavingsBucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsTransaction" ADD CONSTRAINT "SavingsTransaction_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SavingsPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
