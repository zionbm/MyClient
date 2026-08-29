DROP INDEX IF EXISTS "Reminder_idempotencyKey_key";
DROP INDEX IF EXISTS "Quote_idempotencyKey_key";
DROP INDEX IF EXISTS "AiAction_idempotencyKey_key";
DROP INDEX IF EXISTS "OwnerVoiceCommand_idempotencyKey_key";

ALTER TABLE "Note"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Note"
  ADD CONSTRAINT "Note_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Reminder_businessId_idempotencyKey_key" ON "Reminder"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "Quote_businessId_idempotencyKey_key" ON "Quote"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "AiAction_businessId_idempotencyKey_key" ON "AiAction"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "OwnerVoiceCommand_businessId_idempotencyKey_key" ON "OwnerVoiceCommand"("businessId", "idempotencyKey");

CREATE INDEX "Note_businessId_deletedAt_idx" ON "Note"("businessId", "deletedAt");
CREATE INDEX "Note_businessId_createdAt_idx" ON "Note"("businessId", "createdAt");
