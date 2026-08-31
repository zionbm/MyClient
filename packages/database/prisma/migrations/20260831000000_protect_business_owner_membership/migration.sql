UPDATE "BusinessMember"
SET "status" = 'ACTIVE', "updatedAt" = CURRENT_TIMESTAMP
WHERE "memberType" = 'OWNER' AND "status" <> 'ACTIVE';

ALTER TABLE "BusinessMember"
ADD CONSTRAINT "BusinessMember_owner_must_be_active"
CHECK ("memberType" <> 'OWNER' OR "status" = 'ACTIVE');
