CREATE INDEX "Customer_businessId_createdAt_idx" ON "Customer"("businessId", "createdAt");
CREATE INDEX "IncomingCall_businessId_createdAt_idx" ON "IncomingCall"("businessId", "createdAt");
CREATE INDEX "OwnerVoiceCommand_businessId_createdAt_idx" ON "OwnerVoiceCommand"("businessId", "createdAt");
CREATE INDEX "AiPendingAction_businessId_createdAt_idx" ON "AiPendingAction"("businessId", "createdAt");
CREATE INDEX "Notification_businessId_createdAt_idx" ON "Notification"("businessId", "createdAt");
CREATE INDEX "AuditEvent_businessId_createdAt_idx" ON "AuditEvent"("businessId", "createdAt");
