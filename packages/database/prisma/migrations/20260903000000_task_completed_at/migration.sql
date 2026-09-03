ALTER TABLE "Task" ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "Task"
SET "completedAt" = "updatedAt"
WHERE "status" = 'DONE';

CREATE INDEX "Task_businessId_completedAt_idx" ON "Task"("businessId", "completedAt");
