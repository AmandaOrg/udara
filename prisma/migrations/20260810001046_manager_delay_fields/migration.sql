-- AlterTable
ALTER TABLE "SettingsChangeRequest" ADD COLUMN     "initialReplyDueAt" TIMESTAMP(3),
ADD COLUMN     "initialReplySentAt" TIMESTAMP(3);
