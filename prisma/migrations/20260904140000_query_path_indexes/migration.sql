-- Prisma does not create indexes for foreign keys on PostgreSQL, so several
-- hot query paths were sequential scans. Transaction had nothing but its
-- primary key and idempotencyKey, yet it is scanned twice per chat turn and
-- once a minute by the reconciler.

-- CreateIndex
CREATE INDEX "Transaction_userId_status_createdAt_idx" ON "Transaction"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_status_confirmedAt_idx" ON "Transaction"("status", "confirmedAt");

-- CreateIndex
CREATE INDEX "Transaction_status_appliedToAllowanceAt_idx" ON "Transaction"("status", "appliedToAllowanceAt");

-- CreateIndex
CREATE INDEX "WhatsappMessage_fromNumber_createdAt_idx" ON "WhatsappMessage"("fromNumber", "createdAt");

-- CreateIndex
CREATE INDEX "SettingsChangeRequest_status_initialReplySentAt_initialReply_idx" ON "SettingsChangeRequest"("status", "initialReplySentAt", "initialReplyDueAt");

-- CreateIndex
CREATE INDEX "SettingsChangeRequest_userId_status_idx" ON "SettingsChangeRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "OnboardingSession_userId_createdAt_idx" ON "OnboardingSession"("userId", "createdAt");

-- AlterTable
-- Aligns the schema with the column as it was actually created by
-- 20260902220000_weekly_review_updated_at, which added DEFAULT CURRENT_TIMESTAMP.
-- The schema now declares @default(now()), so this is a no-op on an existing
-- database and keeps `migrate dev` from emitting a spurious DROP DEFAULT.
ALTER TABLE "WeeklyReview" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
