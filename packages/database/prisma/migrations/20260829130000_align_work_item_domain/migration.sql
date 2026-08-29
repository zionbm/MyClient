-- Align CRM domain names across API, Prisma, and database.
-- This keeps migrate deploy usable after a fresh database reset.

ALTER TABLE "Notification" RENAME COLUMN "taskId" TO "reminderId";
ALTER TABLE "CallTranscript" RENAME COLUMN "taskId" TO "reminderId";
ALTER TABLE "BusinessSettings" RENAME COLUMN "callbackPrompt" TO "reminderPrompt";

ALTER TABLE "Task" RENAME TO "Reminder";
ALTER TABLE "CustomerNote" RENAME TO "Note";
ALTER TABLE "PendingAction" RENAME TO "AiPendingAction";

ALTER INDEX IF EXISTS "Task_idempotencyKey_key" RENAME TO "Reminder_idempotencyKey_key";
ALTER INDEX IF EXISTS "Task_businessId_idx" RENAME TO "Reminder_businessId_idx";
ALTER INDEX IF EXISTS "Task_businessId_sourceRef_idx" RENAME TO "Reminder_businessId_sourceRef_idx";
ALTER INDEX IF EXISTS "Task_businessId_dueAt_idx" RENAME TO "Reminder_businessId_dueAt_idx";
ALTER INDEX IF EXISTS "Task_businessId_deletedAt_idx" RENAME TO "Reminder_businessId_deletedAt_idx";
ALTER INDEX IF EXISTS "Task_status_dueAt_reminderSentAt_idx" RENAME TO "Reminder_status_dueAt_reminderSentAt_idx";
ALTER INDEX IF EXISTS "CustomerNote_businessId_idx" RENAME TO "Note_businessId_idx";
ALTER INDEX IF EXISTS "CustomerNote_businessId_customerId_idx" RENAME TO "Note_businessId_customerId_idx";
ALTER INDEX IF EXISTS "CustomerNote_businessId_status_idx" RENAME TO "Note_businessId_status_idx";
ALTER INDEX IF EXISTS "PendingAction_businessId_idx" RENAME TO "AiPendingAction_businessId_idx";
ALTER INDEX IF EXISTS "PendingAction_businessId_status_idx" RENAME TO "AiPendingAction_businessId_status_idx";

ALTER TABLE "Reminder" RENAME CONSTRAINT "Task_pkey" TO "Reminder_pkey";
ALTER TABLE "Reminder" RENAME CONSTRAINT "Task_businessId_fkey" TO "Reminder_businessId_fkey";
ALTER TABLE "Reminder" RENAME CONSTRAINT "Task_customerId_fkey" TO "Reminder_customerId_fkey";
ALTER TABLE "Note" RENAME CONSTRAINT "CustomerNote_pkey" TO "Note_pkey";
ALTER TABLE "Note" RENAME CONSTRAINT "CustomerNote_customerId_fkey" TO "Note_customerId_fkey";
ALTER TABLE "AiPendingAction" RENAME CONSTRAINT "PendingAction_pkey" TO "AiPendingAction_pkey";

ALTER TYPE "TaskPriority" RENAME TO "ReminderPriority";
ALTER TYPE "TaskStatus" RENAME TO "ReminderStatus";
ALTER TYPE "ReminderStatus" RENAME VALUE 'COMPLETED' TO 'DONE';
ALTER TYPE "AppointmentStatus" RENAME VALUE 'SCHEDULED' TO 'OPEN';
ALTER TYPE "AppointmentStatus" RENAME VALUE 'COMPLETED' TO 'DONE';
ALTER TYPE "QuoteStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "HomeVisitStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
CREATE TYPE "NoteStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

ALTER TABLE "Note"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "NoteStatus" USING (
    CASE
      WHEN "status" = 'DONE' THEN 'DONE'::"NoteStatus"
      WHEN "status" = 'CANCELLED' THEN 'CANCELLED'::"NoteStatus"
      ELSE 'OPEN'::"NoteStatus"
    END
  ),
  ALTER COLUMN "status" SET DEFAULT 'OPEN';

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

CREATE INDEX "HomeVisit_businessId_idx" ON "HomeVisit"("businessId");
CREATE INDEX "HomeVisit_businessId_startsAt_idx" ON "HomeVisit"("businessId", "startsAt");
CREATE INDEX "HomeVisit_businessId_deletedAt_idx" ON "HomeVisit"("businessId", "deletedAt");

ALTER TABLE "HomeVisit" ADD CONSTRAINT "HomeVisit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HomeVisit" ADD CONSTRAINT "HomeVisit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "Job";
