ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'READ';

ALTER TABLE "PendingAction" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "PendingAction" ADD COLUMN "resolution" JSONB;
ALTER TABLE "PendingAction" ADD COLUMN "resolvedAt" TIMESTAMP(3);

CREATE INDEX "PendingAction_businessId_status_idx" ON "PendingAction"("businessId", "status");

ALTER TABLE "Notification" ADD COLUMN "readAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "failedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "failureReason" TEXT;

CREATE INDEX "Notification_businessId_status_idx" ON "Notification"("businessId", "status");
