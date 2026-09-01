import { z } from "zod";

export const ReminderPrioritySchema = z.enum(["NORMAL", "URGENT"]);
export type ReminderPriority = z.infer<typeof ReminderPrioritySchema>;

export const CreateTaskFromCallSchema = z.object({
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

export type CreateTaskFromCall = z.infer<typeof CreateTaskFromCallSchema>;

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
