import { z } from "zod";

export const ActionTypeSchema = z.enum([
  "CREATE_CUSTOMER",
  "UPDATE_CUSTOMER",
  "CREATE_REMINDER",
  "UPDATE_REMINDER",
  "COMPLETE_REMINDER",
  "CREATE_APPOINTMENT",
  "UPDATE_APPOINTMENT",
  "CANCEL_APPOINTMENT",
  "CREATE_HOME_VISIT",
  "UPDATE_HOME_VISIT",
  "COMPLETE_HOME_VISIT",
  "CREATE_QUOTE",
  "UPDATE_QUOTE",
  "MARK_QUOTE_PAID",
  "CREATE_NOTE",
  "UPDATE_NOTE",
  "DELETE_WORK_ITEM",
  "MERGE_CUSTOMERS"
]);

export type ActionType = z.infer<typeof ActionTypeSchema>;

export const AiActionSchema = z.object({
  type: ActionTypeSchema,
  idempotencyKey: z.string().min(8),
  confidence: z.number().min(0).max(1),
  requiresConfirmation: z.boolean().default(false),
  missingFields: z.array(z.string()).default([]),
  payload: z.record(z.unknown())
});

export type AiAction = z.infer<typeof AiActionSchema>;

export const AiActionBatchSchema = z.object({
  actions: z.array(AiActionSchema).min(1).max(5)
});

export type AiActionBatch = z.infer<typeof AiActionBatchSchema>;

export const ReminderPrioritySchema = z.enum(["NORMAL", "URGENT"]);
export type ReminderPriority = z.infer<typeof ReminderPrioritySchema>;

export const CreateReminderFromCallSchema = z.object({
  businessId: z.string().min(1),
  incomingCallId: z.string().min(1).optional(),
  callerPhone: z.string().optional(),
  callerName: z.string().optional(),
  transcript: z.string().optional(),
  recordingUrl: z.string().optional(),
  priority: ReminderPrioritySchema.default("NORMAL"),
  sourceCallId: z.string().min(1),
  idempotencyKey: z.string().min(8)
});

export type CreateReminderFromCall = z.infer<typeof CreateReminderFromCallSchema>;

export const CreateIncomingCallSchema = z.object({
  businessId: z.string().min(1).optional(),
  plivoCallId: z.string().min(1),
  fromNumber: z.string().optional(),
  toNumber: z.string().min(1),
  selectedDigit: z.string().optional()
});

export type CreateIncomingCall = z.infer<typeof CreateIncomingCallSchema>;

export const CreateCallTranscriptSchema = z.object({
  plivoCallId: z.string().min(1),
  transcript: z.string().trim().min(1),
  recordingUrl: z.string().optional(),
  urgent: z.boolean().optional(),
  provider: z.string().trim().min(1).default("mock-google-stt"),
  confidence: z.number().min(0).max(1).optional()
});

export type CreateCallTranscript = z.infer<typeof CreateCallTranscriptSchema>;

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
  timestamp: z.string(),
  dependencies: z.record(z.string()).optional()
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
