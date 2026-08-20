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

CREATE UNIQUE INDEX "OwnerVoiceCommand_idempotencyKey_key" ON "OwnerVoiceCommand"("idempotencyKey");
CREATE INDEX "OwnerVoiceCommand_businessId_idx" ON "OwnerVoiceCommand"("businessId");
CREATE INDEX "OwnerVoiceCommand_businessId_userId_idx" ON "OwnerVoiceCommand"("businessId", "userId");

ALTER TABLE "OwnerVoiceCommand" ADD CONSTRAINT "OwnerVoiceCommand_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
