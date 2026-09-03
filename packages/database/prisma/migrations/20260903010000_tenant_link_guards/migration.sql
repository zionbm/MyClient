-- Defense-in-depth tenant isolation for relations whose identifiers are accepted
-- from application and assistant commands. These constraints intentionally
-- complement the application-level businessId checks.

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_businessId_id_key" UNIQUE ("businessId", "id");

ALTER TABLE "ServiceAddress"
ADD CONSTRAINT "ServiceAddress_businessId_customerId_id_key"
UNIQUE ("businessId", "customerId", "id");

ALTER TABLE "Job"
ADD CONSTRAINT "Job_businessId_id_key" UNIQUE ("businessId", "id");

ALTER TABLE "Visit"
ADD CONSTRAINT "Visit_businessId_id_key" UNIQUE ("businessId", "id");

ALTER TABLE "Amount"
ADD CONSTRAINT "Amount_businessId_id_key" UNIQUE ("businessId", "id");

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_businessId_mergedIntoCustomerId_fkey"
FOREIGN KEY ("businessId", "mergedIntoCustomerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerPhone"
ADD CONSTRAINT "CustomerPhone_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceAddress"
ADD CONSTRAINT "ServiceAddress_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task"
ADD CONSTRAINT "Task_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Job"
ADD CONSTRAINT "Job_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Job"
ADD CONSTRAINT "Job_businessId_customerId_serviceAddressId_fkey"
FOREIGN KEY ("businessId", "customerId", "serviceAddressId")
REFERENCES "ServiceAddress"("businessId", "customerId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Visit"
ADD CONSTRAINT "Visit_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Visit"
ADD CONSTRAINT "Visit_businessId_customerId_serviceAddressId_fkey"
FOREIGN KEY ("businessId", "customerId", "serviceAddressId")
REFERENCES "ServiceAddress"("businessId", "customerId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Note"
ADD CONSTRAINT "Note_businessId_customerId_fkey"
FOREIGN KEY ("businessId", "customerId")
REFERENCES "Customer"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Amount"
ADD CONSTRAINT "Amount_businessId_jobId_fkey"
FOREIGN KEY ("businessId", "jobId")
REFERENCES "Job"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Amount"
ADD CONSTRAINT "Amount_businessId_visitId_fkey"
FOREIGN KEY ("businessId", "visitId")
REFERENCES "Visit"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AmountEvent"
ADD CONSTRAINT "AmountEvent_businessId_amountId_fkey"
FOREIGN KEY ("businessId", "amountId")
REFERENCES "Amount"("businessId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
