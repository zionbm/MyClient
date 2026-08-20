ALTER TABLE "Task" ADD COLUMN "reminderSentAt" TIMESTAMP(3);

CREATE INDEX "Task_status_dueAt_reminderSentAt_idx" ON "Task"("status", "dueAt", "reminderSentAt");
