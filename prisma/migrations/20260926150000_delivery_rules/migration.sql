-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN     "originChannel" "MessageChannel" NOT NULL DEFAULT 'WHATSAPP';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "lastPushAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "originChannel" "MessageChannel" NOT NULL DEFAULT 'WHATSAPP';

