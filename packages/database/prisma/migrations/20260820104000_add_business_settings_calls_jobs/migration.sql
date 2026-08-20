-- Business settings for IVR, locale and notification preferences.
CREATE TABLE "BusinessSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'he-IL',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "greetingText" TEXT,
    "callbackPrompt" TEXT,
    "urgentPrompt" TEXT,
    "workingHours" JSONB,
    "notificationPhone" TEXT,
    "allowUrgentCalls" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessSettings_businessId_key" ON "BusinessSettings"("businessId");

ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BusinessPhoneNumber" ADD COLUMN "displayName" TEXT;
ALTER TABLE "BusinessPhoneNumber" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "BusinessPhoneNumber" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "BusinessPhoneNumber" ADD CONSTRAINT "BusinessPhoneNumber_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IncomingCall" ADD COLUMN "selectedDigit" TEXT;
ALTER TABLE "IncomingCall" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IncomingCall" ADD COLUMN "recordingUrl" TEXT;

CREATE INDEX "IncomingCall_businessId_toNumber_idx" ON "IncomingCall"("businessId", "toNumber");

ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CallTranscript" ADD COLUMN "taskId" TEXT;
ALTER TABLE "CallTranscript" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE "CallTranscript" ADD COLUMN "confidence" DECIMAL(65,30);

ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_incomingCallId_fkey"
FOREIGN KEY ("incomingCallId") REFERENCES "IncomingCall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
