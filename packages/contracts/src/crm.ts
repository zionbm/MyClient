import { z } from "zod";
import { ReminderPrioritySchema } from "./actions.js";

const OptionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const OptionalDateStringSchema = z.string().trim().min(1).optional();
const RequiredDateStringSchema = z.string().trim().min(1);
const OptionalAmountSchema = z.union([z.number(), z.string().trim().min(1)]).optional();

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional()
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const WorkingHoursSchema = z.record(
  z.object({
    open: z.string().trim().min(1),
    close: z.string().trim().min(1),
    closed: z.boolean().optional()
  })
);

export const UpdateBusinessSettingsSchema = z.object({
  businessName: OptionalNonEmptyStringSchema,
  ownerDisplayName: OptionalNonEmptyStringSchema,
  locale: OptionalNonEmptyStringSchema,
  timezone: OptionalNonEmptyStringSchema,
  greetingText: z.string().trim().min(1).nullable().optional(),
  reminderPrompt: z.string().trim().min(1).nullable().optional(),
  urgentPrompt: z.string().trim().min(1).nullable().optional(),
  workingHours: WorkingHoursSchema.nullable().optional(),
  notificationPhone: z.string().trim().min(1).nullable().optional(),
  allowUrgentCalls: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one settings field is required");

export type UpdateBusinessSettings = z.infer<typeof UpdateBusinessSettingsSchema>;

export const RegisterDeviceTokenSchema = z.object({
  token: z.string().trim().min(1),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: OptionalNonEmptyStringSchema
});

export type RegisterDeviceToken = z.infer<typeof RegisterDeviceTokenSchema>;

export const CreateBusinessPhoneNumberSchema = z.object({
  plivoNumber: z.string().trim().min(1),
  displayName: OptionalNonEmptyStringSchema,
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE")
});

export type CreateBusinessPhoneNumber = z.infer<typeof CreateBusinessPhoneNumberSchema>;

export const UpdateBusinessPhoneNumberSchema = z.object({
  displayName: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one phone number field is required");

export type UpdateBusinessPhoneNumber = z.infer<typeof UpdateBusinessPhoneNumberSchema>;

export const CreateCustomerSchema = z.object({
  name: z.string().trim().min(1),
  phone: OptionalNonEmptyStringSchema,
  email: OptionalNonEmptyStringSchema,
  address: OptionalNonEmptyStringSchema,
  initialNote: OptionalNonEmptyStringSchema
});

export type CreateCustomer = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = z.object({
  name: OptionalNonEmptyStringSchema,
  phone: z.string().trim().min(1).nullable().optional(),
  email: z.string().trim().min(1).nullable().optional(),
  address: z.string().trim().min(1).nullable().optional(),
  initialNote: OptionalNonEmptyStringSchema
}).refine((value) => Object.keys(value).length > 0, "At least one customer field is required");

export type UpdateCustomer = z.infer<typeof UpdateCustomerSchema>;

export const MergeCustomerSchema = z.object({
  targetCustomerId: z.string().trim().min(1),
  fieldChoices: z.object({
    name: z.enum(["source", "target"]).optional(),
    phone: z.enum(["source", "target"]).optional(),
    email: z.enum(["source", "target"]).optional(),
    address: z.enum(["source", "target"]).optional()
  }).optional()
});

export type MergeCustomer = z.infer<typeof MergeCustomerSchema>;

export const WorkItemStatusSchema = z.enum(["OPEN", "DONE", "CANCELLED"]);
export const QuoteStatusSchema = z.enum(["OPEN", "PAID", "CANCELLED"]);

export const CreateReminderSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  description: OptionalNonEmptyStringSchema,
  priority: ReminderPrioritySchema.default("NORMAL"),
  dueAt: OptionalNonEmptyStringSchema,
  status: WorkItemStatusSchema.optional()
});

export type CreateReminder = z.infer<typeof CreateReminderSchema>;

export const UpdateReminderSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  description: z.string().trim().min(1).nullable().optional(),
  priority: ReminderPrioritySchema.optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  status: WorkItemStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one reminder field is required");

export type UpdateReminder = z.infer<typeof UpdateReminderSchema>;

export const CreateNoteSchema = z.object({
  text: z.string().trim().min(1)
});

export type CreateNote = z.infer<typeof CreateNoteSchema>;

export const UpdateNoteSchema = z.object({
  text: z.string().trim().min(1).optional(),
  status: WorkItemStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one note field is required");

export type UpdateNote = z.infer<typeof UpdateNoteSchema>;

export const CreateAppointmentSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  startsAt: z.string().trim().min(1),
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: OptionalNonEmptyStringSchema,
  notes: OptionalNonEmptyStringSchema,
  status: WorkItemStatusSchema.optional()
});

export type CreateAppointment = z.infer<typeof CreateAppointmentSchema>;

export const UpdateAppointmentSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  startsAt: OptionalDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
  status: WorkItemStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one appointment field is required");

export type UpdateAppointment = z.infer<typeof UpdateAppointmentSchema>;

export const CreateHomeVisitSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  startsAt: RequiredDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: OptionalNonEmptyStringSchema,
  notes: OptionalNonEmptyStringSchema,
  status: WorkItemStatusSchema.optional()
});

export type CreateHomeVisit = z.infer<typeof CreateHomeVisitSchema>;

export const UpdateHomeVisitSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  startsAt: OptionalDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
  status: WorkItemStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one home visit field is required");

export type UpdateHomeVisit = z.infer<typeof UpdateHomeVisitSchema>;

export const CreateQuoteSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  dueAt: RequiredDateStringSchema,
  description: OptionalNonEmptyStringSchema,
  estimatedAmount: OptionalAmountSchema,
  status: QuoteStatusSchema.optional()
});

export type CreateQuote = z.infer<typeof CreateQuoteSchema>;

export const UpdateQuoteSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  dueAt: OptionalDateStringSchema,
  description: z.string().trim().min(1).nullable().optional(),
  estimatedAmount: z.union([z.number(), z.string().trim().min(1)]).nullable().optional(),
  status: QuoteStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one quote field is required");

export type UpdateQuote = z.infer<typeof UpdateQuoteSchema>;

export const ListByStatusQuerySchema = PaginationQuerySchema.extend({
  status: z.string().trim().min(1).optional()
});

export type ListByStatusQuery = z.infer<typeof ListByStatusQuerySchema>;

export const NotificationListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(["PENDING", "SENT", "FAILED", "READ"]).optional()
});

export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const AiPendingActionListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(["PENDING", "EXECUTING", "EXECUTED", "REJECTED"]).optional()
});

export type AiPendingActionListQuery = z.infer<typeof AiPendingActionListQuerySchema>;

export const HomeQuerySchema = z.object({
  date: OptionalDateStringSchema,
  search: OptionalNonEmptyStringSchema,
  filter: z.enum(["all", "urgent", "reminders", "home_visits", "appointments", "quotes", "calls"]).default("all")
});

export type HomeQuery = z.infer<typeof HomeQuerySchema>;

export const UpdateNotificationSchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "READ"]),
  failureReason: z.string().trim().min(1).optional()
});

export type UpdateNotification = z.infer<typeof UpdateNotificationSchema>;

export const SnoozeNotificationSchema = z.object({
  preset: z.enum(["IN_15_MINUTES", "IN_2_HOURS", "TOMORROW_09_00"])
});

export type SnoozeNotification = z.infer<typeof SnoozeNotificationSchema>;

export const ApproveAiPendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional()
});

export type ApproveAiPendingAction = z.infer<typeof ApproveAiPendingActionSchema>;

export const UpdateAiPendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  missingFields: z.array(z.string()).optional(),
  reviewReason: z.string().trim().min(1).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one AI pending action field is required");

export type UpdateAiPendingAction = z.infer<typeof UpdateAiPendingActionSchema>;

export const CreateBusinessMemberSchema = z.object({
  phoneNumber: z.string().trim().min(1),
  displayName: OptionalNonEmptyStringSchema,
  memberType: z.enum(["OWNER", "EMPLOYEE"]).default("EMPLOYEE")
});

export type CreateBusinessMember = z.infer<typeof CreateBusinessMemberSchema>;

export const OwnerVoiceCommandHeadersSchema = z.object({
  idempotencyKey: z.string().trim().min(8),
  languageCode: z.string().trim().min(1).default("he-IL"),
  filename: z.string().trim().min(1).default("owner-command.m4a")
});

export type OwnerVoiceCommandHeaders = z.infer<typeof OwnerVoiceCommandHeadersSchema>;

export const OwnerVoiceCommandTranscriptSchema = z.object({
  transcript: z.string().trim().min(2),
  languageCode: z.string().trim().min(1).default("he-IL"),
  sttProvider: z.string().trim().min(1).default("openai-realtime"),
  sttConfidence: z.number().min(0).max(1).nullable().optional()
});

export type OwnerVoiceCommandTranscript = z.infer<typeof OwnerVoiceCommandTranscriptSchema>;

export const VoiceRealtimeSessionSchema = z.object({
  value: z.string().trim().min(1),
  expiresAt: z.number(),
  model: z.string().trim().min(1)
});

export type VoiceRealtimeSession = z.infer<typeof VoiceRealtimeSessionSchema>;

export const VoiceCommandResultFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  state: z.enum(["normal", "missing"]).default("normal")
});

export const VoiceCommandResultItemSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  kind: z.enum(["customer", "reminder", "home_visit", "appointment", "quote", "note", "action"]),
  status: z.enum(["created", "updated", "completed", "pending", "failed"]),
  title: z.string(),
  subtitle: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  fields: z.array(VoiceCommandResultFieldSchema).default([]),
  entityId: z.string().optional(),
  aiPendingActionId: z.string().optional(),
  missingFields: z.array(z.string()).default([])
});

export const VoiceCommandResultSchema = z.object({
  state: z.enum(["done", "needs_review", "needs_input", "failed", "unsupported"]),
  title: z.string(),
  summary: z.string(),
  transcript: z.string().nullable(),
  items: z.array(VoiceCommandResultItemSchema).default([]),
  primaryAction: z.string().optional(),
  secondaryActions: z.array(z.string()).default([])
});

export type VoiceCommandResult = z.infer<typeof VoiceCommandResultSchema>;
