-- AlterEnum
ALTER TYPE "NudgeType" ADD VALUE 'HABIT_FORMING_FOLLOWUP';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "city" TEXT,
ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "email" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "occupation" TEXT;
