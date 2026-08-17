-- AlterEnum
ALTER TYPE "WhatsappMessageType" ADD VALUE 'FLOW_REPLY';

-- AlterTable
ALTER TABLE "WhatsappMessage" ADD COLUMN     "flowResponseJson" JSONB;
