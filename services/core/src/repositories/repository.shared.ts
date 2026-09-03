import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma.service.js";

export type RepositoryTransaction = Prisma.TransactionClient;

export function inRepositoryTransaction<T>(
  prisma: PrismaService,
  transaction: RepositoryTransaction | undefined,
  operation: (tx: RepositoryTransaction) => Promise<T>
): Promise<T> {
  return transaction ? operation(transaction) : prisma.$transaction(operation);
}

export type CreateBusinessMemberInput = {
  businessId: string;
  phoneNumber: string;
  displayName?: string;
  memberType?: "OWNER" | "EMPLOYEE";
  addedByUserId?: string;
};

export type DisableBusinessMemberInput = { businessId: string; memberId: string };

export type CreateNotificationInput = {
  businessId: string;
  itemType?: string;
  itemId?: string;
  title: string;
  body: string;
  payload?: Prisma.InputJsonValue;
};

export type CreateAiPendingActionInput = {
  businessId: string;
  userId?: string;
  actionType: string;
  source?: string;
  confidence?: number;
  reviewReason?: string;
  payload: Prisma.InputJsonValue;
  missingFields: string[];
};

export type UpdateAiPendingActionInput = {
  businessId: string;
  aiPendingActionId: string;
  payload?: Prisma.InputJsonValue;
  missingFields?: string[];
  reviewReason?: string | null;
};

export type UpdateNotificationInput = {
  businessId: string;
  notificationId: string;
  status: "PENDING" | "SENT" | "FAILED" | "READ";
  failureReason?: string;
};

export type RegisterDeviceTokenInput = {
  businessId: string;
  userId: string;
  token: string;
  platform?: string;
  appVersion?: string;
};

export type ResolveAiPendingActionInput = {
  businessId: string;
  aiPendingActionId: string;
  expectedStatus?: string;
  status: "EXECUTED" | "REJECTED";
  resolution?: Prisma.InputJsonValue;
};

export type RegisterBusinessInput = {
  firebaseUid: string;
  email?: string;
  phoneNumber?: string;
  displayName: string;
  businessName: string;
};

export type UpdateBusinessSettingsInput = {
  businessId: string;
  actorUserId?: string;
  businessName?: string;
  ownerDisplayName?: string;
  locale?: string;
  timezone?: string;
  greetingText?: string | null;
  reminderPrompt?: string | null;
  urgentPrompt?: string | null;
  workingHours?: Prisma.InputJsonValue | null;
  notificationPhone?: string | null;
  allowUrgentCalls?: boolean;
};

export type CreateBusinessPhoneNumberInput = {
  businessId: string;
  plivoNumber: string;
  displayName?: string;
  status?: string;
};

export type UpdateBusinessPhoneNumberInput = {
  businessId: string;
  phoneNumberId: string;
  displayName?: string | null;
  status?: string;
};

export type CreateIncomingCallInput = {
  businessId: string;
  plivoCallId: string;
  fromNumber?: string;
  toNumber: string;
  selectedDigit?: string;
  urgent?: boolean;
  status: string;
};

export type UpdateIncomingCallInput = {
  plivoCallId: string;
  status?: string;
  selectedDigit?: string;
  urgent?: boolean;
  recordingUrl?: string;
};

export type CreateCallTranscriptInput = {
  businessId: string;
  incomingCallId: string;
  transcript: string;
  taskId?: string;
  provider?: string;
  confidence?: number;
};

export type AuditEventInput = {
  businessId: string;
  actorType: string;
  actorId?: string;
  source: string;
  entityType: string;
  entityId?: string;
  action: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  result?: string;
};

export type PaginationCursor = { createdAt: Date; id: string };
export type PaginationInput = { limit: number; cursor?: PaginationCursor };

export function createdAtCursorWhere(cursor: PaginationCursor | undefined) {
  return cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {};
}

export function paginationTake(pagination: PaginationInput | undefined) {
  return pagination ? pagination.limit + 1 : undefined;
}
