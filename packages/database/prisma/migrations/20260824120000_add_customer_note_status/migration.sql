ALTER TABLE "CustomerNote" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';

CREATE INDEX "CustomerNote_businessId_status_idx" ON "CustomerNote"("businessId", "status");
