import { z } from "zod";

const OptionalNonEmptyStringSchema = z.string().trim().min(1).optional();
const WorkingHoursTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Working-hours time must use HH:mm");

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional()
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const WorkingHoursSchema = z.record(z.object({
  open: WorkingHoursTimeSchema,
  close: WorkingHoursTimeSchema,
  closed: z.boolean().optional()
})).superRefine((hours, context) => {
  for (const [day, value] of Object.entries(hours)) {
    if (!value.closed && value.open >= value.close) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [day], message: "Opening time must be before closing time" });
    }
  }
});

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

export const RegisterDeviceTokenSchema = z.object({
  token: z.string().trim().min(1),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: OptionalNonEmptyStringSchema
});

export const CreateBusinessPhoneNumberSchema = z.object({
  plivoNumber: z.string().trim().min(1),
  displayName: OptionalNonEmptyStringSchema,
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE")
});

export const UpdateBusinessPhoneNumberSchema = z.object({
  displayName: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one phone number field is required");

export const NotificationListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(["PENDING", "SENT", "FAILED", "READ"]).optional()
});

export const UpdateNotificationSchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "READ"]),
  failureReason: z.string().trim().min(1).optional()
});

export const SnoozeNotificationSchema = z.object({
  preset: z.enum(["IN_15_MINUTES", "IN_2_HOURS", "TOMORROW_09_00"])
});

export const CreateBusinessMemberSchema = z.object({
  phoneNumber: z.string().trim().min(1),
  displayName: OptionalNonEmptyStringSchema,
  memberType: z.literal("EMPLOYEE").default("EMPLOYEE")
});
