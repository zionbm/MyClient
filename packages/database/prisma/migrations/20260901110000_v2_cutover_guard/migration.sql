ALTER TABLE "Business"
ADD COLUMN "v1WriteBlockedAt" TIMESTAMP(3);

CREATE INDEX "Business_v1WriteBlockedAt_idx"
ON "Business"("v1WriteBlockedAt");
