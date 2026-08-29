import { Prisma } from "@prisma/client";

export type CreateReminderInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date;
  status?: "OPEN" | "DONE" | "CANCELLED";
  source: string;
  sourceRef?: string;
  idempotencyKey?: string;
};

export type UpdateReminderInput = {
  businessId: string;
  reminderId: string;
  customerId?: string | null;
  title?: string;
  description?: string | null;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type CreateBusinessMemberInput = {
  businessId: string;
  phoneNumber: string;
  displayName?: string;
  memberType?: "OWNER" | "EMPLOYEE";
  addedByUserId?: string;
};

export type CustomerMergeField = "name" | "phone" | "email" | "address";
export type CustomerMergeChoice = "source" | "target";

export function mergeCustomerFields(
  source: Record<CustomerMergeField, string | null>,
  target: Record<CustomerMergeField, string | null>,
  choices?: Partial<Record<CustomerMergeField, CustomerMergeChoice>>
) {
  const data: Pick<Prisma.CustomerUpdateInput, "name" | "phone" | "email" | "address"> = {};
  for (const field of ["name", "phone", "email", "address"] as const) {
    const sourceValue = source[field]?.trim() || null;
    const targetValue = target[field]?.trim() || null;
    const choice = choices?.[field];
    const selected = choice === "source"
      ? sourceValue
      : choice === "target"
        ? targetValue
        : targetValue ?? sourceValue;

    if (selected !== targetValue) {
      switch (field) {
        case "name":
          if (selected !== null) {
            data.name = selected;
          }
          break;
        case "phone":
          data.phone = selected;
          break;
        case "email":
          data.email = selected;
          break;
        case "address":
          data.address = selected;
          break;
      }
    }
  }
  return data;
}

export type DisableBusinessMemberInput = {
  businessId: string;
  memberId: string;
};

export type CreateCustomerInput = {
  businessId: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
};

export type UpdateCustomerInput = {
  businessId: string;
  customerId: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
};

export type CreateNoteInput = {
  businessId: string;
  customerId: string;
  text: string;
};

export type UpdateNoteInput = {
  businessId: string;
  customerId: string;
  noteId: string;
  text?: string;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type CreateNotificationInput = {
  businessId: string;
  reminderId?: string;
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

export type CreateOwnerVoiceCommandInput = {
  businessId: string;
  userId: string;
  languageCode: string;
  idempotencyKey: string;
};

export type UpdateOwnerVoiceCommandInput = {
  id: string;
  transcript?: string;
  sttProvider?: string;
  sttConfidence?: number;
  llmProvider?: string;
  llmAction?: Prisma.InputJsonValue;
  executionStatus?: string;
  executionResult?: Prisma.InputJsonValue;
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
  reminderId?: string;
  provider?: string;
  confidence?: number;
};

export type CreateAppointmentInput = {
  businessId: string;
  customerId?: string;
  title: string;
  location?: string;
  notes?: string;
  startsAt: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type UpdateAppointmentInput = {
  businessId: string;
  appointmentId: string;
  customerId?: string | null;
  title?: string;
  location?: string | null;
  notes?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type CreateHomeVisitInput = {
  businessId: string;
  customerId?: string;
  title: string;
  location?: string;
  notes?: string;
  startsAt: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type UpdateHomeVisitInput = {
  businessId: string;
  homeVisitId: string;
  customerId?: string | null;
  title?: string;
  location?: string | null;
  notes?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

export type CreateQuoteInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  estimatedAmount?: Prisma.Decimal | number | string;
  dueAt: Date;
  status?: "OPEN" | "PAID" | "CANCELLED";
  source?: string;
  sourceRef?: string;
  idempotencyKey?: string;
};

export type UpdateQuoteInput = {
  businessId: string;
  quoteId: string;
  customerId?: string | null;
  title?: string;
  description?: string | null;
  estimatedAmount?: Prisma.Decimal | number | string | null;
  dueAt?: Date;
  status?: "OPEN" | "PAID" | "CANCELLED";
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

export type PaginationCursor = {
  createdAt: Date;
  id: string;
};

export type PaginationInput = {
  limit: number;
  cursor?: PaginationCursor;
};

export function createdAtCursorWhere(cursor: PaginationCursor | undefined) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } }
        ]
      }
    : {};
}

export function paginationTake(pagination: PaginationInput | undefined) {
  return pagination ? pagination.limit + 1 : undefined;
}

