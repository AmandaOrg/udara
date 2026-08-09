-- CreateEnum
CREATE TYPE "IncomeType" AS ENUM ('SALARIED', 'FOUNDER', 'MULTIPLE_STREAMS');

-- CreateEnum
CREATE TYPE "BudgetMethod" AS ENUM ('FLAT', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "IncomePosture" AS ENUM ('RESTRICT', 'GROW');

-- CreateEnum
CREATE TYPE "OnboardingStage" AS ENUM ('DISCOVERY', 'WELCOME', 'IDENTITY', 'MONEY_STORY', 'AI_REFLECTION', 'STRUCTURED_QUESTIONS', 'PLAN_PROPOSED', 'ACCOUNT_CREATED', 'FUNDED', 'FIRST_TRANSACTION', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('NORMAL', 'EARLY_ACCESS', 'BORROWED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecipientLabel" AS ENUM ('RENT', 'FOOD', 'VENDOR', 'OTHER');

-- CreateEnum
CREATE TYPE "SettingsChangeType" AS ENUM ('WINDOW_HOURS', 'OVERRIDE_FEES', 'EXIT_RESTRICTIONS', 'OTHER');

-- CreateEnum
CREATE TYPE "SettingsChangeStatus" AS ENUM ('PENDING', 'ELIGIBLE_FOR_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WhatsappMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WhatsappMessageType" AS ENUM ('TEXT', 'BUTTON_REPLY', 'LIST_REPLY', 'AUDIO', 'IMAGE', 'DOCUMENT', 'LOCATION', 'STATUS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WhatsappMessageStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationPersona" AS ENUM ('KEDU', 'MANAGER');

-- CreateEnum
CREATE TYPE "ConversationSessionStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "LlmCallPurpose" AS ENUM ('ONBOARDING_EXTRACTION', 'CONVERSATION_REPLY', 'MANAGER_REPLY', 'TRANSFER_INTENT_PARSE', 'INTENT_CLASSIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "RubiesWebhookEventType" AS ENUM ('TRANSFER_STATUS', 'INCOMING_CREDIT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "NudgeType" AS ENUM ('WINDOW_OPEN', 'DAILY_SUMMARY', 'BORROW_WARNING', 'SETTINGS_ELIGIBLE', 'OTHER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "whatsappNumber" TEXT NOT NULL,
    "rubiesAccountId" TEXT,
    "monthlyIncome" DECIMAL(14,2),
    "incomeType" "IncomeType",
    "incomePosture" "IncomePosture" NOT NULL DEFAULT 'RESTRICT',
    "budgetMethod" "BudgetMethod" NOT NULL DEFAULT 'FLAT',
    "budgetPercentage" DECIMAL(5,4),
    "flatDailyAmount" DECIMAL(14,2),
    "strictnessLevel" INTEGER,
    "statedGoal" TEXT,
    "statedGoalSetAt" TIMESTAMP(3),
    "windowStartHour" INTEGER NOT NULL DEFAULT 11,
    "windowEndHour" INTEGER NOT NULL DEFAULT 20,
    "disciplineExitedAt" TIMESTAMP(3),
    "bvn" TEXT,
    "nin" TEXT,
    "rubiesAccountNumber" TEXT,
    "rubiesAccountName" TEXT,
    "rubiesBankCode" TEXT,
    "lastInboundMessageAt" TIMESTAMP(3),
    "onboardingStage" "OnboardingStage" NOT NULL DEFAULT 'DISCOVERY',
    "onboardingCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAllowance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "weekStartDate" DATE NOT NULL,
    "amountAllocated" DECIMAL(14,2) NOT NULL,
    "surplusCarriedIn" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountSpent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountName" TEXT,
    "label" "RecipientLabel" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "type" "TransactionType" NOT NULL DEFAULT 'NORMAL',
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rubiesReference" TEXT,
    "dailyAllowanceId" TEXT,
    "appliedToAllowanceAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "whatsappMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverrideHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "feeAmount" DECIMAL(14,2) NOT NULL,
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverrideHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingsChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SettingsChangeType" NOT NULL,
    "requestedChange" TEXT NOT NULL,
    "reason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibleAt" TIMESTAMP(3) NOT NULL,
    "status" "SettingsChangeStatus" NOT NULL DEFAULT 'PENDING',
    "managerNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SettingsChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stage" "OnboardingStage" NOT NULL,
    "messages" JSONB NOT NULL,
    "extractedData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "waMessageId" TEXT NOT NULL,
    "direction" "WhatsappMessageDirection" NOT NULL,
    "type" "WhatsappMessageType" NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "textBody" TEXT,
    "buttonPayload" TEXT,
    "mediaId" TEXT,
    "mediaMimeType" TEXT,
    "transcript" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "WhatsappMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "persona" "ConversationPersona" NOT NULL DEFAULT 'KEDU',
    "status" "ConversationSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "messages" JSONB NOT NULL,
    "contextData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "purpose" "LlmCallPurpose" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "latencyMs" INTEGER,
    "rawResponse" JSONB NOT NULL,
    "validationResult" JSONB,
    "appliedToUser" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubiesWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" "RubiesWebhookEventType" NOT NULL,
    "rubiesReference" TEXT,
    "rawPayload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RubiesWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "rubiesReference" TEXT NOT NULL,
    "sourceNarration" TEXT,
    "creditedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NudgeLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NudgeType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL,
    "templateName" TEXT,

    CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_whatsappNumber_key" ON "User"("whatsappNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_rubiesAccountId_key" ON "User"("rubiesAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "User_rubiesAccountNumber_key" ON "User"("rubiesAccountNumber");

-- CreateIndex
CREATE INDEX "DailyAllowance_userId_weekStartDate_idx" ON "DailyAllowance"("userId", "weekStartDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAllowance_userId_date_key" ON "DailyAllowance"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Recipient_userId_accountNumber_bankCode_key" ON "Recipient"("userId", "accountNumber", "bankCode");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OverrideHistory_transactionId_key" ON "OverrideHistory"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappMessage_waMessageId_key" ON "WhatsappMessage"("waMessageId");

-- CreateIndex
CREATE INDEX "WhatsappMessage_userId_createdAt_idx" ON "WhatsappMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationSession_userId_status_idx" ON "ConversationSession"("userId", "status");

-- CreateIndex
CREATE INDEX "LlmCallLog_userId_purpose_createdAt_idx" ON "LlmCallLog"("userId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "RubiesWebhookEvent_rubiesReference_idx" ON "RubiesWebhookEvent"("rubiesReference");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingCredit_rubiesReference_key" ON "IncomingCredit"("rubiesReference");

-- CreateIndex
CREATE INDEX "NudgeLog_userId_type_sentAt_idx" ON "NudgeLog"("userId", "type", "sentAt");

-- AddForeignKey
ALTER TABLE "DailyAllowance" ADD CONSTRAINT "DailyAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_dailyAllowanceId_fkey" FOREIGN KEY ("dailyAllowanceId") REFERENCES "DailyAllowance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverrideHistory" ADD CONSTRAINT "OverrideHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverrideHistory" ADD CONSTRAINT "OverrideHistory_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingsChangeRequest" ADD CONSTRAINT "SettingsChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingSession" ADD CONSTRAINT "OnboardingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappMessage" ADD CONSTRAINT "WhatsappMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationSession" ADD CONSTRAINT "ConversationSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingCredit" ADD CONSTRAINT "IncomingCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NudgeLog" ADD CONSTRAINT "NudgeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
