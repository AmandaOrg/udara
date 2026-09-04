-- AlterTable
ALTER TABLE "NudgeLog" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "NudgeLog_dedupeKey_key" ON "NudgeLog"("dedupeKey");
