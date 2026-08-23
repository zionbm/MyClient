import { z } from "zod";
import { CallbackTaskPrioritySchema } from "./actions.js";

const OptionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const OptionalDateStringSchema = z.string().trim().min(1).optional();
const RequiredDateStringSchema = z.string().trim().min(1);
const OptionalAmountSchema = z.union([z.number(), z.string().trim().min(1)]).optional();

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
  callbackPrompt: z.string().trim().min(1).nullable().optional(),
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
  targetCustomerId: z.string().trim().min(1)
});

export type MergeCustomer = z.infer<typeof MergeCustomerSchema>;

export const CreateTaskSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  description: OptionalNonEmptyStringSchema,
  priority: CallbackTaskPrioritySchema.default("NORMAL"),
  dueAt: OptionalNonEmptyStringSchema
});

export type CreateTask = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: OptionalNonEmptyStringSchema,
  description: OptionalNonEmptyStringSchema,
  priority: CallbackTaskPrioritySchema.optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one task field is required");

export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

export const CreateCallbackSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  description: OptionalNonEmptyStringSchema,
  priority: CallbackTaskPrioritySchema.default("NORMAL"),
  dueAt: OptionalDateStringSchema
});

export type CreateCallback = z.infer<typeof CreateCallbackSchema>;

export const UpdateCallbackSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  description: z.string().trim().min(1).nullable().optional(),
  priority: CallbackTaskPrioritySchema.optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["OPEN", "DONE"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one callback field is required");

export type UpdateCallback = z.infer<typeof UpdateCallbackSchema>;

export const CreateCustomerNoteSchema = z.object({
  text: z.string().trim().min(1)
});

export type CreateCustomerNote = z.infer<typeof CreateCustomerNoteSchema>;

export const CreateAppointmentSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  startsAt: z.string().trim().min(1),
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: OptionalNonEmptyStringSchema,
  notes: OptionalNonEmptyStringSchema
});

export type CreateAppointment = z.infer<typeof CreateAppointmentSchema>;

export const UpdateAppointmentSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  startsAt: OptionalDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one appointment field is required");

export type UpdateAppointment = z.infer<typeof UpdateAppointmentSchema>;

export const CreateHomeVisitSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  startsAt: RequiredDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: OptionalNonEmptyStringSchema,
  notes: OptionalNonEmptyStringSchema
});

export type CreateHomeVisit = z.infer<typeof CreateHomeVisitSchema>;

export const UpdateHomeVisitSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  startsAt: OptionalDateStringSchema,
  endsAt: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().min(1).nullable().optional(),
  notes: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["OPEN", "DONE"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one home visit field is required");

export type UpdateHomeVisit = z.infer<typeof UpdateHomeVisitSchema>;

export const CreateQuoteSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  dueAt: RequiredDateStringSchema,
  description: OptionalNonEmptyStringSchema,
  estimatedAmount: OptionalAmountSchema
});

export type CreateQuote = z.infer<typeof CreateQuoteSchema>;

export const UpdateQuoteSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalNonEmptyStringSchema,
  dueAt: OptionalDateStringSchema,
  description: z.string().trim().min(1).nullable().optional(),
  estimatedAmount: z.union([z.number(), z.string().trim().min(1)]).nullable().optional(),
  status: z.enum(["OPEN", "PAID"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one quote field is required");

export type UpdateQuote = z.infer<typeof UpdateQuoteSchema>;

export const CreateJobSchema = z.object({
  customerId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalNonEmptyStringSchema,
  status: OptionalNonEmptyStringSchema
});

export type CreateJob = z.infer<typeof CreateJobSchema>;

export const UpdateJobSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: OptionalNonEmptyStringSchema,
  description: z.string().trim().min(1).nullable().optional(),
  status: OptionalNonEmptyStringSchema
}).refine((value) => Object.keys(value).length > 0, "At least one job field is required");

export type UpdateJob = z.infer<typeof UpdateJobSchema>;

export const ListByStatusQuerySchema = z.object({
  status: z.string().trim().min(1).optional()
});

export type ListByStatusQuery = z.infer<typeof ListByStatusQuerySchema>;

export const HomeQuerySchema = z.object({
  date: OptionalDateStringSchema,
  search: OptionalNonEmptyStringSchema,
  filter: z.enum(["all", "urgent", "callbacks", "home_visits", "quotes", "calls"]).default("all")
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

export const CompletePendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional()
});

export type CompletePendingAction = z.infer<typeof CompletePendingActionSchema>;

export const UpdatePendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  missingFields: z.array(z.string()).optional(),
  reviewReason: z.string().trim().min(1).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one pending action field is required");

export type UpdatePendingAction = z.infer<typeof UpdatePendingActionSchema>;

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
