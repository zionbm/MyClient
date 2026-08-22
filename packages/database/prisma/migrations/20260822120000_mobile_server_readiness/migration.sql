CREATE TYPE "BusinessMemberType" AS ENUM ('OWNER', 'EMPLOYEE');
CREATE TYPE "BusinessMemberStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');
CREATE TYPE "QuoteStatus" AS ENUM ('OPEN', 'PAID');

ALTER TABLE "User" ALTER COLUMN "businessId" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "phoneNumber" TEXT;

CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
CREATE INDEX "User_phoneNumber_idx" ON "User"("phoneNumber");

CREATE TABLE "BusinessMember" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT,
  "phoneNumber" TEXT NOT NULL,
  "memberType" "BusinessMemberType" NOT NULL DEFAULT 'EMPLOYEE',
  "status" "BusinessMemberStatus" NOT NULL DEFAULT 'PENDING',
  "addedByUserId" TEXT,
  "linkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessMember_businessId_phoneNumber_key" ON "BusinessMember"("businessId", "phoneNumber");
CREATE INDEX "BusinessMember_businessId_idx" ON "BusinessMember"("businessId");
CREATE INDEX "BusinessMember_businessId_status_idx" ON "BusinessMember"("businessId", "status");
CREATE INDEX "BusinessMember_phoneNumber_idx" ON "BusinessMember"("phoneNumber");
CREATE INDEX "BusinessMember_userId_idx" ON "BusinessMember"("userId");

ALTER TABLE "BusinessMember"
  ADD CONSTRAINT "BusinessMember_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BusinessMember"
  ADD CONSTRAINT "BusinessMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Customer"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "mergedIntoCustomerId" TEXT,
  ADD COLUMN "mergedAt" TIMESTAMP(3),
  ADD COLUMN "mergedByUserId" TEXT;

CREATE INDEX "Customer_businessId_deletedAt_idx" ON "Customer"("businessId", "deletedAt");
CREATE INDEX "Customer_businessId_mergedIntoCustomerId_idx" ON "Customer"("businessId", "mergedIntoCustomerId");

ALTER TABLE "Appointment"
  ADD COLUMN "location" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Appointment_businessId_startsAt_idx" ON "Appointment"("businessId", "startsAt");
CREATE INDEX "Appointment_businessId_deletedAt_idx" ON "Appointment"("businessId", "deletedAt");

ALTER TABLE "Task" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Task_businessId_dueAt_idx" ON "Task"("businessId", "dueAt");
CREATE INDEX "Task_businessId_deletedAt_idx" ON "Task"("businessId", "deletedAt");

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

CREATE UNIQUE INDEX "Quote_idempotencyKey_key" ON "Quote"("idempotencyKey");
CREATE INDEX "Quote_businessId_idx" ON "Quote"("businessId");
CREATE INDEX "Quote_businessId_customerId_idx" ON "Quote"("businessId", "customerId");
CREATE INDEX "Quote_businessId_dueAt_idx" ON "Quote"("businessId", "dueAt");
CREATE INDEX "Quote_businessId_deletedAt_idx" ON "Quote"("businessId", "deletedAt");
CREATE INDEX "Quote_status_dueAt_reminderSentAt_idx" ON "Quote"("status", "dueAt", "reminderSentAt");

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PendingAction"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ai',
  ADD COLUMN "confidence" DECIMAL(65,30),
  ADD COLUMN "reviewReason" TEXT;

ALTER TABLE "Notification"
  ADD COLUMN "itemType" TEXT,
  ADD COLUMN "itemId" TEXT;

CREATE INDEX "Notification_businessId_itemType_itemId_idx" ON "Notification"("businessId", "itemType", "itemId");

INSERT INTO "BusinessMember" ("id", "businessId", "userId", "phoneNumber", "memberType", "status", "linkedAt", "createdAt", "updatedAt")
SELECT 'legacy-member-' || "id", "businessId", "id", COALESCE("phoneNumber", 'legacy-user-' || "id"), 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User"
WHERE "businessId" IS NOT NULL
ON CONFLICT ("businessId", "phoneNumber") DO NOTHING;
