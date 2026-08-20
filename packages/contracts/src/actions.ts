import { z } from "zod";

export const ActionTypeSchema = z.enum([
  "CREATE_CUSTOMER",
  "UPDATE_CUSTOMER",
  "CREATE_JOB",
  "UPDATE_JOB",
  "CREATE_APPOINTMENT",
  "UPDATE_APPOINTMENT",
  "CANCEL_APPOINTMENT",
  "CREATE_TASK",
  "UPDATE_TASK",
  "COMPLETE_TASK",
  "ADD_CUSTOMER_NOTE"
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

export const CallbackTaskPrioritySchema = z.enum(["NORMAL", "URGENT"]);
export type CallbackTaskPriority = z.infer<typeof CallbackTaskPrioritySchema>;

export const CreateCallbackTaskSchema = z.object({
  businessId: z.string().min(1),
  incomingCallId: z.string().min(1).optional(),
  callerPhone: z.string().optional(),
  callerName: z.string().optional(),
  transcript: z.string().optional(),
  recordingUrl: z.string().optional(),
  priority: CallbackTaskPrioritySchema.default("NORMAL"),
  sourceCallId: z.string().min(1),
  idempotencyKey: z.string().min(8)
});

export type CreateCallbackTask = z.infer<typeof CreateCallbackTaskSchema>;

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
