-- CreateTable
CREATE TABLE "NameEnquiryLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NameEnquiryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NameEnquiryLog_userId_createdAt_idx" ON "NameEnquiryLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BillPayment_userId_createdAt_idx" ON "BillPayment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IncomingCredit_userId_creditedAt_idx" ON "IncomingCredit"("userId", "creditedAt");

-- AddForeignKey
ALTER TABLE "NameEnquiryLog" ADD CONSTRAINT "NameEnquiryLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

