-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'PIN_RESET_OTP';

-- AlterEnum
ALTER TYPE "PinChallengePurpose" ADD VALUE 'RESET';

-- AlterTable
ALTER TABLE "PinChallenge" ADD COLUMN     "otpAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "otpHash" TEXT;
