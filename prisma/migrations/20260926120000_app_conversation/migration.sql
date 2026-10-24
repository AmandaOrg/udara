-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'APP');

-- CreateEnum
CREATE TYPE "AppMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "AppMessageKind" AS ENUM ('TEXT', 'BUTTONS', 'LIST', 'FORM_REQUEST', 'CHOICE', 'FORM_SUBMISSION', 'START');

-- CreateEnum
CREATE TYPE "AppMessageStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "AppMessage" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "AppMessageDirection" NOT NULL,
    "kind" "AppMessageKind" NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "clientMessageId" TEXT,
    "status" "AppMessageStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTurnLease" (
    "userId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastChannel" "MessageChannel",

    CONSTRAINT "UserTurnLease_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppMessage_seq_key" ON "AppMessage"("seq");

-- CreateIndex
CREATE INDEX "AppMessage_userId_seq_idx" ON "AppMessage"("userId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AppMessage_userId_clientMessageId_key" ON "AppMessage"("userId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "AppMessage" ADD CONSTRAINT "AppMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTurnLease" ADD CONSTRAINT "UserTurnLease_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

