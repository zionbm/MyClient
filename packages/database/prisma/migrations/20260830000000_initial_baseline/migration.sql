-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderPriority" AS ENUM ('NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "HomeVisitStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'FAILED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "BusinessMemberType" AS ENUM ('OWNER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "BusinessMemberStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

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
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "deletedAt" TIMESTAMP(3),
    "mergedIntoCustomerId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "mergedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "AppointmentStatus" NOT NULL DEFAULT 'OPEN',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeVisit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" "HomeVisitStatus" NOT NULL DEFAULT 'OPEN',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ReminderStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ReminderPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'app',
    "sourceRef" TEXT,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "estimatedAmount" DECIMAL(65,30),
    "status" "QuoteStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reminderSentAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'app',
    "sourceRef" TEXT,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
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
    "reminderId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "confidence" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "actionType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerVoiceCommand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL DEFAULT 'he-IL',
    "transcript" TEXT,
    "sttProvider" TEXT,
    "sttConfidence" DECIMAL(65,30),
    "llmProvider" TEXT,
    "llmAction" JSONB,
    "executionStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "executionResult" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerVoiceCommand_pkey" PRIMARY KEY ("id")
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "reminderId" TEXT,
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
CREATE INDEX "Appointment_businessId_idx" ON "Appointment"("businessId");

-- CreateIndex
CREATE INDEX "Appointment_businessId_createdAt_idx" ON "Appointment"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Appointment_businessId_startsAt_idx" ON "Appointment"("businessId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_businessId_deletedAt_idx" ON "Appointment"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "HomeVisit_businessId_idx" ON "HomeVisit"("businessId");

-- CreateIndex
CREATE INDEX "HomeVisit_businessId_createdAt_idx" ON "HomeVisit"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "HomeVisit_businessId_startsAt_idx" ON "HomeVisit"("businessId", "startsAt");

-- CreateIndex
CREATE INDEX "HomeVisit_businessId_deletedAt_idx" ON "HomeVisit"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Reminder_businessId_idx" ON "Reminder"("businessId");

-- CreateIndex
CREATE INDEX "Reminder_businessId_createdAt_idx" ON "Reminder"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Reminder_businessId_sourceRef_idx" ON "Reminder"("businessId", "sourceRef");

-- CreateIndex
CREATE INDEX "Reminder_businessId_dueAt_idx" ON "Reminder"("businessId", "dueAt");

-- CreateIndex
CREATE INDEX "Reminder_businessId_deletedAt_idx" ON "Reminder"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Reminder_status_dueAt_reminderSentAt_idx" ON "Reminder"("status", "dueAt", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_businessId_idempotencyKey_key" ON "Reminder"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Quote_businessId_idx" ON "Quote"("businessId");

-- CreateIndex
CREATE INDEX "Quote_businessId_customerId_idx" ON "Quote"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Quote_businessId_createdAt_idx" ON "Quote"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_businessId_dueAt_idx" ON "Quote"("businessId", "dueAt");

-- CreateIndex
CREATE INDEX "Quote_businessId_deletedAt_idx" ON "Quote"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "Quote_status_dueAt_reminderSentAt_idx" ON "Quote"("status", "dueAt", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_businessId_idempotencyKey_key" ON "Quote"("businessId", "idempotencyKey");

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
CREATE INDEX "AiAction_businessId_idx" ON "AiAction"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "AiAction_businessId_idempotencyKey_key" ON "AiAction"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OwnerVoiceCommand_businessId_idx" ON "OwnerVoiceCommand"("businessId");

-- CreateIndex
CREATE INDEX "OwnerVoiceCommand_businessId_createdAt_idx" ON "OwnerVoiceCommand"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerVoiceCommand_businessId_userId_idx" ON "OwnerVoiceCommand"("businessId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerVoiceCommand_businessId_idempotencyKey_key" ON "OwnerVoiceCommand"("businessId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_idx" ON "AiPendingAction"("businessId");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_createdAt_idx" ON "AiPendingAction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AiPendingAction_businessId_status_idx" ON "AiPendingAction"("businessId", "status");

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
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeVisit" ADD CONSTRAINT "HomeVisit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeVisit" ADD CONSTRAINT "HomeVisit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "OwnerVoiceCommand" ADD CONSTRAINT "OwnerVoiceCommand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
