-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "AmountEventType" AS ENUM ('CREATE', 'ADD_PAYMENT', 'SET_PAID_TOTAL', 'SETTLE_BALANCE', 'CHANGE_TOTAL', 'CORRECTION', 'UNDO');

-- CreateEnum
CREATE TYPE "PendingStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ActionBatchStatus" AS ENUM ('COMPLETED', 'PARTIALLY_COMPLETED', 'WAITING', 'FAILED', 'UNDONE');

-- CreateEnum
CREATE TYPE "AssistantResponseMode" AS ENUM ('TEXT_ONLY', 'TEXT_AND_VOICE');

-- AlterTable
ALTER TABLE "AiPendingAction" ADD COLUMN     "actionBatchId" TEXT,
ADD COLUMN     "actionBatchStepId" TEXT,
ADD COLUMN     "assistantSessionId" TEXT,
ADD COLUMN     "candidateEntities" JSONB,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "dependencyStepKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "entityVersions" JSONB,
ADD COLUMN     "question" TEXT,
ADD COLUMN     "requiresExplicitConfirmation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolvedByUserId" TEXT;

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "productModelVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "deleteActionBatchId" TEXT,
ADD COLUMN     "deletedByUserId" TEXT,
ADD COLUMN     "generalNotes" TEXT,
ADD COLUMN     "normalizedName" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CustomerPhone" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rawPhone" TEXT NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAddress" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "addressText" TEXT NOT NULL,
    "normalizedAddress" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'app',
    "sourceRef" TEXT,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "serviceAddressId" TEXT,
    "locationSnapshot" TEXT,
    "status" "ActivityStatus" NOT NULL DEFAULT 'OPEN',
    "executionCompletedAt" TIMESTAMP(3),
    "executionCompletedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "serviceAddressId" TEXT,
    "locationSnapshot" TEXT,
    "status" "ActivityStatus" NOT NULL DEFAULT 'OPEN',
    "executionCompletedAt" TIMESTAMP(3),
    "executionCompletedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Amount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT,
    "visitId" TEXT,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Amount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmountEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amountId" TEXT NOT NULL,
    "actionBatchId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "eventType" "AmountEventType" NOT NULL,
    "previousTotal" DECIMAL(14,2) NOT NULL,
    "nextTotal" DECIMAL(14,2) NOT NULL,
    "previousPaid" DECIMAL(14,2) NOT NULL,
    "nextPaid" DECIMAL(14,2) NOT NULL,
    "paidDelta" DECIMAL(14,2) NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmountEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionBatch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "assistantSessionId" TEXT,
    "voiceCommandId" TEXT,
    "approvedTranscript" TEXT,
    "proposedPlan" JSONB,
    "finalSummary" TEXT NOT NULL,
    "spokenSummary" TEXT,
    "status" "ActionBatchStatus" NOT NULL,
    "undoEligibleUntil" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "undoneByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionBatchStep" (
    "id" TEXT NOT NULL,
    "actionBatchId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL,
    "toolName" TEXT,
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionBatchStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionMutation" (
    "id" TEXT NOT NULL,
    "actionBatchId" TEXT NOT NULL,
    "actionBatchStepId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionMutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientSessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "currentCustomerId" TEXT,
    "currentEntityType" TEXT,
    "currentEntityId" TEXT,
    "activePendingActionId" TEXT,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantTurn" (
    "id" TEXT NOT NULL,
    "assistantSessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "approvedTranscript" TEXT,
    "actionBatchId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assistantResponseMode" "AssistantResponseMode" NOT NULL DEFAULT 'TEXT_ONLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerPhone_businessId_customerId_idx" ON "CustomerPhone"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerPhone_businessId_normalizedPhone_idx" ON "CustomerPhone"("businessId", "normalizedPhone");

-- CreateIndex
CREATE INDEX "CustomerPhone_businessId_deletedAt_idx" ON "CustomerPhone"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "ServiceAddress_businessId_customerId_idx" ON "ServiceAddress"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "ServiceAddress_businessId_deletedAt_idx" ON "ServiceAddress"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Task_businessId_customerId_idx" ON "Task"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Task_businessId_status_dueAt_idx" ON "Task"("businessId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_businessId_deletedAt_idx" ON "Task"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_reminderSentAt_idx" ON "Task"("status", "dueAt", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_businessId_idempotencyKey_key" ON "Task"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_businessId_customerId_idx" ON "Job"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Job_businessId_startsAt_idx" ON "Job"("businessId", "startsAt");

-- CreateIndex
CREATE INDEX "Job_businessId_status_idx" ON "Job"("businessId", "status");

-- CreateIndex
CREATE INDEX "Job_businessId_deletedAt_idx" ON "Job"("businessId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_businessId_idempotencyKey_key" ON "Job"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Visit_businessId_customerId_idx" ON "Visit"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Visit_businessId_startsAt_idx" ON "Visit"("businessId", "startsAt");

-- CreateIndex
CREATE INDEX "Visit_businessId_status_idx" ON "Visit"("businessId", "status");

-- CreateIndex
CREATE INDEX "Visit_businessId_deletedAt_idx" ON "Visit"("businessId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_businessId_idempotencyKey_key" ON "Visit"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Amount_businessId_paymentStatus_idx" ON "Amount"("businessId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Amount_businessId_jobId_idx" ON "Amount"("businessId", "jobId");

-- CreateIndex
CREATE INDEX "Amount_businessId_visitId_idx" ON "Amount"("businessId", "visitId");

-- CreateIndex
CREATE INDEX "Amount_businessId_deletedAt_idx" ON "Amount"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "AmountEvent_businessId_occurredAt_idx" ON "AmountEvent"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "AmountEvent_amountId_occurredAt_idx" ON "AmountEvent"("amountId", "occurredAt");

-- CreateIndex
CREATE INDEX "AmountEvent_actionBatchId_idx" ON "AmountEvent"("actionBatchId");

-- CreateIndex
CREATE INDEX "ActionBatch_businessId_createdAt_idx" ON "ActionBatch"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionBatch_businessId_actorUserId_createdAt_idx" ON "ActionBatch"("businessId", "actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionBatch_assistantSessionId_idx" ON "ActionBatch"("assistantSessionId");

-- CreateIndex
CREATE INDEX "ActionBatch_voiceCommandId_idx" ON "ActionBatch"("voiceCommandId");

-- CreateIndex
CREATE INDEX "ActionBatchStep_actionBatchId_createdAt_idx" ON "ActionBatchStep"("actionBatchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionBatchStep_actionBatchId_stepKey_key" ON "ActionBatchStep"("actionBatchId", "stepKey");

-- CreateIndex
CREATE INDEX "ActionMutation_actionBatchStepId_idx" ON "ActionMutation"("actionBatchStepId");

-- CreateIndex
CREATE INDEX "ActionMutation_entityType_entityId_idx" ON "ActionMutation"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionMutation_actionBatchId_sequence_key" ON "ActionMutation"("actionBatchId", "sequence");

-- CreateIndex
CREATE INDEX "AssistantSession_businessId_userId_expiresAt_idx" ON "AssistantSession"("businessId", "userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantSession_businessId_userId_clientSessionId_key" ON "AssistantSession"("businessId", "userId", "clientSessionId");

-- CreateIndex
CREATE INDEX "AssistantTurn_assistantSessionId_createdAt_idx" ON "AssistantTurn"("assistantSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantTurn_expiresAt_idx" ON "AssistantTurn"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_userId_key" ON "UserPreference"("userId");

-- CreateIndex
CREATE INDEX "AiPendingAction_actionBatchId_idx" ON "AiPendingAction"("actionBatchId");

-- CreateIndex
CREATE INDEX "AiPendingAction_assistantSessionId_idx" ON "AiPendingAction"("assistantSessionId");

-- AddForeignKey
ALTER TABLE "CustomerPhone" ADD CONSTRAINT "CustomerPhone_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPhone" ADD CONSTRAINT "CustomerPhone_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddress" ADD CONSTRAINT "ServiceAddress_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddress" ADD CONSTRAINT "ServiceAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_serviceAddressId_fkey" FOREIGN KEY ("serviceAddressId") REFERENCES "ServiceAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_serviceAddressId_fkey" FOREIGN KEY ("serviceAddressId") REFERENCES "ServiceAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Amount" ADD CONSTRAINT "Amount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Amount" ADD CONSTRAINT "Amount_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Amount" ADD CONSTRAINT "Amount_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmountEvent" ADD CONSTRAINT "AmountEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmountEvent" ADD CONSTRAINT "AmountEvent_amountId_fkey" FOREIGN KEY ("amountId") REFERENCES "Amount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmountEvent" ADD CONSTRAINT "AmountEvent_actionBatchId_fkey" FOREIGN KEY ("actionBatchId") REFERENCES "ActionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionBatch" ADD CONSTRAINT "ActionBatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionBatch" ADD CONSTRAINT "ActionBatch_assistantSessionId_fkey" FOREIGN KEY ("assistantSessionId") REFERENCES "AssistantSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionBatchStep" ADD CONSTRAINT "ActionBatchStep_actionBatchId_fkey" FOREIGN KEY ("actionBatchId") REFERENCES "ActionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionMutation" ADD CONSTRAINT "ActionMutation_actionBatchId_fkey" FOREIGN KEY ("actionBatchId") REFERENCES "ActionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionMutation" ADD CONSTRAINT "ActionMutation_actionBatchStepId_fkey" FOREIGN KEY ("actionBatchStepId") REFERENCES "ActionBatchStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantSession" ADD CONSTRAINT "AssistantSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantTurn" ADD CONSTRAINT "AssistantTurn_assistantSessionId_fkey" FOREIGN KEY ("assistantSessionId") REFERENCES "AssistantSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantTurn" ADD CONSTRAINT "AssistantTurn_actionBatchId_fkey" FOREIGN KEY ("actionBatchId") REFERENCES "ActionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- V2 domain invariants that Prisma cannot express directly.
CREATE UNIQUE INDEX "CustomerPhone_businessId_normalizedPhone_active_key"
ON "CustomerPhone"("businessId", "normalizedPhone")
WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Amount_jobId_active_key"
ON "Amount"("jobId")
WHERE "deletedAt" IS NULL AND "jobId" IS NOT NULL;

CREATE UNIQUE INDEX "Amount_visitId_active_key"
ON "Amount"("visitId")
WHERE "deletedAt" IS NULL AND "visitId" IS NOT NULL;

ALTER TABLE "Amount"
ADD CONSTRAINT "Amount_exactly_one_activity_check"
CHECK (("jobId" IS NOT NULL)::integer + ("visitId" IS NOT NULL)::integer = 1),
ADD CONSTRAINT "Amount_non_negative_check"
CHECK ("totalAmount" >= 0 AND "paidAmount" >= 0),
ADD CONSTRAINT "Amount_paid_not_above_total_check"
CHECK ("paidAmount" <= "totalAmount");

ALTER TABLE "Job"
ADD CONSTRAINT "Job_valid_time_range_check"
CHECK ("endsAt" IS NULL OR ("startsAt" IS NOT NULL AND "endsAt" > "startsAt"));

ALTER TABLE "Visit"
ADD CONSTRAINT "Visit_valid_time_range_check"
CHECK ("endsAt" IS NULL OR ("startsAt" IS NOT NULL AND "endsAt" > "startsAt"));
