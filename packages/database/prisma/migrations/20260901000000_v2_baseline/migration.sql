-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "BusinessMemberType" AS ENUM ('OWNER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "BusinessMemberStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "AmountEventType" AS ENUM ('CREATE', 'ADD_PAYMENT', 'SET_PAID_TOTAL', 'SETTLE_BALANCE', 'CHANGE_TOTAL', 'CORRECTION', 'UNDO');

-- CreateEnum
CREATE TYPE "ActionBatchStatus" AS ENUM ('COMPLETED', 'PARTIALLY_COMPLETED', 'WAITING', 'FAILED', 'UNDONE');

-- CreateEnum
CREATE TYPE "AssistantResponseMode" AS ENUM ('TEXT_ONLY', 'TEXT_AND_VOICE');

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'he-IL',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "greetingText" TEXT,
    "reminderPrompt" TEXT,
    "urgentPrompt" TEXT,
    "workingHours" JSONB,
    "notificationPhone" TEXT,
    "allowUrgentCalls" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "email" TEXT,
    "phoneNumber" TEXT,
    "displayName" TEXT,
    "firebaseUid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessMember" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "memberType" "BusinessMemberType" NOT NULL DEFAULT 'EMPLOYEE',
    "status" "BusinessMemberStatus" NOT NULL DEFAULT 'PENDING',
    "addedByUserId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "deletedAt" TIMESTAMP(3),
    "mergedIntoCustomerId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "mergedByUserId" TEXT,
    "normalizedName" TEXT,
    "generalNotes" TEXT,
    "deletedByUserId" TEXT,
    "deleteActionBatchId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "NoteStatus" NOT NULL DEFAULT 'OPEN',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPhoneNumber" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "plivoNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingCall" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "plivoCallId" TEXT NOT NULL,
    "fromNumber" TEXT,
    "toNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "selectedDigit" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomingCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTranscript" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "incomingCallId" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "taskId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "confidence" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTranscript_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "ApiIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPendingAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "actionType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "confidence" DECIMAL(65,30),
    "reviewReason" TEXT,
    "payload" JSONB NOT NULL,
    "missingFields" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolution" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "actionBatchId" TEXT,
    "actionBatchStepId" TEXT,
    "createdByUserId" TEXT,
    "resolvedByUserId" TEXT,
    "assistantSessionId" TEXT,
    "question" TEXT,
    "candidateEntities" JSONB,
    "entityVersions" JSONB,
    "dependencyStepKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiresExplicitConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemType" TEXT,
    "itemId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "appVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSettings_businessId_key" ON "BusinessSettings"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE INDEX "User_businessId_idx" ON "User"("businessId");

-- CreateIndex
CREATE INDEX "User_phoneNumber_idx" ON "User"("phoneNumber");

-- CreateIndex
CREATE INDEX "BusinessMember_businessId_idx" ON "BusinessMember"("businessId");

-- CreateIndex
CREATE INDEX "BusinessMember_businessId_status_idx" ON "BusinessMember"("businessId", "status");

-- CreateIndex
CREATE INDEX "BusinessMember_phoneNumber_idx" ON "BusinessMember"("phoneNumber");

-- CreateIndex
CREATE INDEX "BusinessMember_userId_idx" ON "BusinessMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMember_businessId_phoneNumber_key" ON "BusinessMember"("businessId", "phoneNumber");

-- CreateIndex
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");

-- CreateIndex
CREATE INDEX "Customer_businessId_createdAt_idx" ON "Customer"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_businessId_deletedAt_idx" ON "Customer"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Customer_businessId_mergedIntoCustomerId_idx" ON "Customer"("businessId", "mergedIntoCustomerId");

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
CREATE INDEX "Note_businessId_idx" ON "Note"("businessId");

-- CreateIndex
CREATE INDEX "Note_businessId_customerId_idx" ON "Note"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Note_businessId_status_idx" ON "Note"("businessId", "status");

-- CreateIndex
CREATE INDEX "Note_businessId_deletedAt_idx" ON "Note"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Note_businessId_createdAt_idx" ON "Note"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPhoneNumber_plivoNumber_key" ON "BusinessPhoneNumber"("plivoNumber");

-- CreateIndex
CREATE INDEX "BusinessPhoneNumber_businessId_idx" ON "BusinessPhoneNumber"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingCall_plivoCallId_key" ON "IncomingCall"("plivoCallId");

-- CreateIndex
CREATE INDEX "IncomingCall_businessId_idx" ON "IncomingCall"("businessId");

-- CreateIndex
CREATE INDEX "IncomingCall_businessId_createdAt_idx" ON "IncomingCall"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "IncomingCall_businessId_toNumber_idx" ON "IncomingCall"("businessId", "toNumber");

-- CreateIndex
CREATE INDEX "CallTranscript_businessId_idx" ON "CallTranscript"("businessId");

-- CreateIndex
CREATE INDEX "CallTranscript_incomingCallId_idx" ON "CallTranscript"("incomingCallId");

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
CREATE INDEX "ApiIdempotencyRecord_expiresAt_idx" ON "ApiIdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "ApiIdempotencyRecord_businessId_createdAt_idx" ON "ApiIdempotencyRecord"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiIdempotencyRecord_businessId_userId_scope_key_key" ON "ApiIdempotencyRecord"("businessId", "userId", "scope", "key");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_idx" ON "AiPendingAction"("businessId");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_createdAt_idx" ON "AiPendingAction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_status_idx" ON "AiPendingAction"("businessId", "status");

-- CreateIndex
CREATE INDEX "AiPendingAction_actionBatchId_idx" ON "AiPendingAction"("actionBatchId");

-- CreateIndex
CREATE INDEX "AiPendingAction_assistantSessionId_idx" ON "AiPendingAction"("assistantSessionId");

-- CreateIndex
CREATE INDEX "Notification_businessId_idx" ON "Notification"("businessId");

-- CreateIndex
CREATE INDEX "Notification_businessId_createdAt_idx" ON "Notification"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_businessId_status_idx" ON "Notification"("businessId", "status");

-- CreateIndex
CREATE INDEX "Notification_businessId_itemType_itemId_idx" ON "Notification"("businessId", "itemType", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_businessId_idx" ON "DeviceToken"("businessId");

-- CreateIndex
CREATE INDEX "DeviceToken_businessId_status_idx" ON "DeviceToken"("businessId", "status");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

-- CreateIndex
CREATE INDEX "AuditEvent_businessId_idx" ON "AuditEvent"("businessId");

-- CreateIndex
CREATE INDEX "AuditEvent_businessId_createdAt_idx" ON "AuditEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_businessId_idx" ON "UsageEvent"("businessId");

-- AddForeignKey
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "Note" ADD CONSTRAINT "Note_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPhoneNumber" ADD CONSTRAINT "BusinessPhoneNumber_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_incomingCallId_fkey" FOREIGN KEY ("incomingCallId") REFERENCES "IncomingCall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "ApiIdempotencyRecord" ADD CONSTRAINT "ApiIdempotencyRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Domain invariants that Prisma cannot express directly.
ALTER TABLE "BusinessMember"
ADD CONSTRAINT "BusinessMember_owner_must_be_active"
CHECK ("memberType" <> 'OWNER' OR "status" = 'ACTIVE');

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

