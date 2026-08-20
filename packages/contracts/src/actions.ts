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
  callerPhone: z.string().optional(),
  callerName: z.string().optional(),
  transcript: z.string().optional(),
  priority: CallbackTaskPrioritySchema.default("NORMAL"),
  sourceCallId: z.string().min(1),
  idempotencyKey: z.string().min(8)
});

export type CreateCallbackTask = z.infer<typeof CreateCallbackTaskSchema>;

export const HealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
  timestamp: z.string(),
  dependencies: z.record(z.string()).optional()
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
