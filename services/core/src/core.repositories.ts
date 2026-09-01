import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service.js";
import { BusinessesRepository } from "./repositories/business.repositories.js";
import {
  CallTranscriptsRepository,
  IncomingCallsRepository,
  OwnerVoiceCommandsRepository
} from "./repositories/communications.repositories.js";
import {
  CustomersRepository,
  NotesRepository,
  RemindersRepository
} from "./repositories/crm.repositories.js";
import {
  AiPendingActionsRepository,
  DeviceTokensRepository,
  NotificationsRepository
} from "./repositories/automation.repositories.js";
import {
  AppointmentsRepository,
  HomeVisitsRepository,
  QuotesRepository
} from "./repositories/scheduling.repositories.js";

export {
  AuditRepository,
  AuthRepository,
  BusinessMembersRepository,
  BusinessesRepository,
  BusinessPhoneNumbersRepository,
  BusinessSettingsRepository
} from "./repositories/business.repositories.js";

export {
  CallTranscriptsRepository,
  IncomingCallsRepository,
  OwnerVoiceCommandsRepository
} from "./repositories/communications.repositories.js";

export {
  CustomersRepository,
  NotesRepository,
  RemindersRepository
} from "./repositories/crm.repositories.js";

export {
  AiPendingActionsRepository,
  DeviceTokensRepository,
  NotificationsRepository
} from "./repositories/automation.repositories.js";

export {
  AppointmentsRepository,
  HomeVisitsRepository,
  QuotesRepository
} from "./repositories/scheduling.repositories.js";

export {
  ActionBatchesRepository,
  AssistantSessionsRepository,
  UserPreferencesRepository
} from "./repositories/v2-foundation.repositories.js";

export {
  V2CustomerPhonesRepository,
  V2CustomersRepository,
  V2ServiceAddressesRepository,
  V2TasksRepository
} from "./repositories/v2-crm.repositories.js";

export { V2ActivitiesRepository } from "./repositories/v2-activities.repositories.js";
export { V2AmountsRepository } from "./repositories/v2-amounts.repositories.js";

type CreateReminderInput = {
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

type UpdateReminderInput = {
  businessId: string;
  reminderId: string;
  customerId?: string | null;
  title?: string;
  description?: string | null;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

type CreateBusinessMemberInput = {
  businessId: string;
  phoneNumber: string;
  displayName?: string;
  memberType?: "OWNER" | "EMPLOYEE";
  addedByUserId?: string;
};

type CustomerMergeField = "name" | "phone" | "email" | "address";
type CustomerMergeChoice = "source" | "target";

function mergeCustomerFields(
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

type DisableBusinessMemberInput = {
  businessId: string;
  memberId: string;
};

type CreateCustomerInput = {
  businessId: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
};

type UpdateCustomerInput = {
  businessId: string;
  customerId: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
};

type CreateNoteInput = {
  businessId: string;
  customerId: string;
  text: string;
};

type UpdateNoteInput = {
  businessId: string;
  customerId: string;
  noteId: string;
  text?: string;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

type CreateNotificationInput = {
  businessId: string;
  reminderId?: string;
  itemType?: string;
  itemId?: string;
  title: string;
  body: string;
  payload?: Prisma.InputJsonValue;
};

type CreateAiPendingActionInput = {
  businessId: string;
  userId?: string;
  actionType: string;
  source?: string;
  confidence?: number;
  reviewReason?: string;
  payload: Prisma.InputJsonValue;
  missingFields: string[];
};

type UpdateAiPendingActionInput = {
  businessId: string;
  aiPendingActionId: string;
  payload?: Prisma.InputJsonValue;
  missingFields?: string[];
  reviewReason?: string | null;
};

type UpdateNotificationInput = {
  businessId: string;
  notificationId: string;
  status: "PENDING" | "SENT" | "FAILED" | "READ";
  failureReason?: string;
};

type RegisterDeviceTokenInput = {
  businessId: string;
  userId: string;
  token: string;
  platform?: string;
  appVersion?: string;
};

type ResolveAiPendingActionInput = {
  businessId: string;
  aiPendingActionId: string;
  expectedStatus?: string;
  status: "EXECUTED" | "REJECTED";
  resolution?: Prisma.InputJsonValue;
};

type CreateOwnerVoiceCommandInput = {
  businessId: string;
  userId: string;
  languageCode: string;
  idempotencyKey: string;
};

type UpdateOwnerVoiceCommandInput = {
  id: string;
  transcript?: string;
  sttProvider?: string;
  sttConfidence?: number;
  llmProvider?: string;
  llmAction?: Prisma.InputJsonValue;
  executionStatus?: string;
  executionResult?: Prisma.InputJsonValue;
};

type RegisterBusinessInput = {
  firebaseUid: string;
  email?: string;
  phoneNumber?: string;
  displayName: string;
  businessName: string;
};

type UpdateBusinessSettingsInput = {
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

type CreateBusinessPhoneNumberInput = {
  businessId: string;
  plivoNumber: string;
  displayName?: string;
  status?: string;
};

type UpdateBusinessPhoneNumberInput = {
  businessId: string;
  phoneNumberId: string;
  displayName?: string | null;
  status?: string;
};

type CreateIncomingCallInput = {
  businessId: string;
  plivoCallId: string;
  fromNumber?: string;
  toNumber: string;
  selectedDigit?: string;
  urgent?: boolean;
  status: string;
};

type UpdateIncomingCallInput = {
  plivoCallId: string;
  status?: string;
  selectedDigit?: string;
  urgent?: boolean;
  recordingUrl?: string;
};

type CreateCallTranscriptInput = {
  businessId: string;
  incomingCallId: string;
  transcript: string;
  reminderId?: string;
  provider?: string;
  confidence?: number;
};

type CreateAppointmentInput = {
  businessId: string;
  customerId?: string;
  title: string;
  location?: string;
  notes?: string;
  startsAt: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

type UpdateAppointmentInput = {
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

type CreateHomeVisitInput = {
  businessId: string;
  customerId?: string;
  title: string;
  location?: string;
  notes?: string;
  startsAt: Date;
  endsAt?: Date | null;
  status?: "OPEN" | "DONE" | "CANCELLED";
};

type UpdateHomeVisitInput = {
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

type CreateQuoteInput = {
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

type UpdateQuoteInput = {
  businessId: string;
  quoteId: string;
  customerId?: string | null;
  title?: string;
  description?: string | null;
  estimatedAmount?: Prisma.Decimal | number | string | null;
  dueAt?: Date;
  status?: "OPEN" | "PAID" | "CANCELLED";
};

type AuditEventInput = {
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

type PaginationCursor = {
  createdAt: Date;
  id: string;
};

type PaginationInput = {
  limit: number;
  cursor?: PaginationCursor;
};

function createdAtCursorWhere(cursor: PaginationCursor | undefined) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } }
        ]
      }
    : {};
}

function paginationTake(pagination: PaginationInput | undefined) {
  return pagination ? pagination.limit + 1 : undefined;
}
