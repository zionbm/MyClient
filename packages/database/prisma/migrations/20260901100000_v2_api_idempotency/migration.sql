CREATE TABLE "ApiIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "response" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiIdempotencyRecord_businessId_userId_scope_key_key"
ON "ApiIdempotencyRecord"("businessId", "userId", "scope", "key");

CREATE INDEX "ApiIdempotencyRecord_expiresAt_idx"
ON "ApiIdempotencyRecord"("expiresAt");

CREATE INDEX "ApiIdempotencyRecord_businessId_createdAt_idx"
ON "ApiIdempotencyRecord"("businessId", "createdAt");

ALTER TABLE "ApiIdempotencyRecord"
ADD CONSTRAINT "ApiIdempotencyRecord_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
