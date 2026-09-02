import { z } from "zod";

export const V2TaskStatusSchema = z.enum(["OPEN", "DONE", "CANCELLED"]);
export type V2TaskStatus = z.infer<typeof V2TaskStatusSchema>;

export const V2ActivityStatusSchema = z.enum(["OPEN", "CLOSED", "CANCELLED"]);
export type V2ActivityStatus = z.infer<typeof V2ActivityStatusSchema>;

export const V2PaymentStatusSchema = z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]);
export type V2PaymentStatus = z.infer<typeof V2PaymentStatusSchema>;

export const V2AmountEventTypeSchema = z.enum([
  "CREATE",
  "ADD_PAYMENT",
  "SET_PAID_TOTAL",
  "SETTLE_BALANCE",
  "CHANGE_TOTAL",
  "CORRECTION",
  "UNDO"
]);
export type V2AmountEventType = z.infer<typeof V2AmountEventTypeSchema>;

export const V2PaymentModeSchema = z.enum(["ADD", "SET_PAID_TOTAL", "SETTLE_BALANCE"]);
export type V2PaymentMode = z.infer<typeof V2PaymentModeSchema>;

export const V2PendingStatusSchema = z.enum(["PENDING", "COMPLETED", "REJECTED"]);
export type V2PendingStatus = z.infer<typeof V2PendingStatusSchema>;

export const V2ActionBatchStatusSchema = z.enum([
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "WAITING",
  "FAILED",
  "UNDONE"
]);
export type V2ActionBatchStatus = z.infer<typeof V2ActionBatchStatusSchema>;

export const AssistantResponseModeSchema = z.enum(["TEXT_ONLY", "TEXT_AND_VOICE"]);
export type AssistantResponseMode = z.infer<typeof AssistantResponseModeSchema>;

export const V2CurrencySchema = z.literal("ILS");
export type V2Currency = z.infer<typeof V2CurrencySchema>;

export const V2MoneySchema = z.coerce.number().finite().min(0).multipleOf(0.01);
export type V2Money = z.infer<typeof V2MoneySchema>;

export const V2PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional()
});
export type V2PaginationQuery = z.infer<typeof V2PaginationQuerySchema>;

export const IdempotencyKeySchema = z.string().trim().min(1).max(200);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const V2EntityVersionSchema = z.number().int().positive();
export type V2EntityVersion = z.infer<typeof V2EntityVersionSchema>;

const OptionalTrimmedStringSchema = z.string().trim().min(1).optional();
const NullableTrimmedStringSchema = z.string().trim().min(1).nullable().optional();
const OptionalIsoDateSchema = z.string().datetime({ offset: true }).optional();
const NullableIsoDateSchema = z.string().datetime({ offset: true }).nullable().optional();

export const V2CreateCustomerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  generalNotes: OptionalTrimmedStringSchema
});
export type V2CreateCustomer = z.infer<typeof V2CreateCustomerSchema>;

export const V2UpdateCustomerSchema = z.object({
  name: OptionalTrimmedStringSchema,
  email: z.string().trim().email().nullable().optional(),
  generalNotes: NullableTrimmedStringSchema,
  version: V2EntityVersionSchema.optional()
}).refine((value) => Object.keys(value).some((key) => key !== "version"), {
  message: "At least one customer field is required"
});
export type V2UpdateCustomer = z.infer<typeof V2UpdateCustomerSchema>;

export const V2CreateCustomerPhoneSchema = z.object({
  phone: z.string().trim().min(1),
  label: OptionalTrimmedStringSchema,
  isPrimary: z.boolean().optional()
});
export type V2CreateCustomerPhone = z.infer<typeof V2CreateCustomerPhoneSchema>;

export const V2UpdateCustomerPhoneSchema = z.object({
  phone: OptionalTrimmedStringSchema,
  label: NullableTrimmedStringSchema,
  isPrimary: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one phone field is required"
});
export type V2UpdateCustomerPhone = z.infer<typeof V2UpdateCustomerPhoneSchema>;

export const V2CreateServiceAddressSchema = z.object({
  label: OptionalTrimmedStringSchema,
  addressText: z.string().trim().min(1)
});
export type V2CreateServiceAddress = z.infer<typeof V2CreateServiceAddressSchema>;

export const V2UpdateServiceAddressSchema = z.object({
  label: NullableTrimmedStringSchema,
  addressText: OptionalTrimmedStringSchema
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one address field is required"
});
export type V2UpdateServiceAddress = z.infer<typeof V2UpdateServiceAddressSchema>;

export const V2CreateTaskSchema = z.object({
  customerId: OptionalTrimmedStringSchema,
  title: z.string().trim().min(1),
  description: OptionalTrimmedStringSchema,
  dueAt: OptionalIsoDateSchema,
  status: V2TaskStatusSchema.optional()
});
export type V2CreateTask = z.infer<typeof V2CreateTaskSchema>;

export const V2UpdateTaskSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalTrimmedStringSchema,
  description: NullableTrimmedStringSchema,
  dueAt: NullableIsoDateSchema,
  status: V2TaskStatusSchema.optional(),
  version: V2EntityVersionSchema.optional()
}).refine((value) => Object.keys(value).some((key) => key !== "version"), {
  message: "At least one task field is required"
});
export type V2UpdateTask = z.infer<typeof V2UpdateTaskSchema>;

export const V2CreateNoteSchema = z.object({
  text: z.string().trim().min(1),
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional()
});
export type V2CreateNote = z.infer<typeof V2CreateNoteSchema>;

export const V2UpdateNoteSchema = z.object({
  text: OptionalTrimmedStringSchema,
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one note field is required"
});
export type V2UpdateNote = z.infer<typeof V2UpdateNoteSchema>;

export const V2ConfirmedMutationSchema = z.object({
  confirmed: z.literal(true)
});
export type V2ConfirmedMutation = z.infer<typeof V2ConfirmedMutationSchema>;

export const V2MergeCustomerSchema = V2ConfirmedMutationSchema.extend({
  targetCustomerId: z.string().trim().min(1)
});
export type V2MergeCustomer = z.infer<typeof V2MergeCustomerSchema>;

export const ASSISTANT_TOOL_NAMES = [
  "FIND_CUSTOMERS",
  "GET_CUSTOMER_TIMELINE",
  "FIND_TASKS",
  "FIND_JOBS",
  "FIND_VISITS",
  "GET_ACTIVITY_AMOUNT",
  "GET_SCHEDULE",
  "GET_AVAILABILITY",
  "GET_PAYMENT_SUMMARY",
  "GET_OPEN_BALANCES",
  "GET_TODAY_OVERVIEW",
  "CREATE_CUSTOMER",
  "UPDATE_CUSTOMER",
  "ADD_CUSTOMER_PHONE",
  "UPDATE_CUSTOMER_PHONE",
  "DELETE_CUSTOMER_PHONE",
  "ADD_SERVICE_ADDRESS",
  "UPDATE_SERVICE_ADDRESS",
  "DELETE_SERVICE_ADDRESS",
  "CREATE_TASK",
  "UPDATE_TASK",
  "COMPLETE_TASK",
  "CANCEL_TASK",
  "REOPEN_TASK",
  "DELETE_TASK",
  "CREATE_NOTE",
  "UPDATE_NOTE",
  "CREATE_JOB",
  "UPDATE_JOB",
  "REPORT_JOB_COMPLETED",
  "CANCEL_JOB",
  "REOPEN_JOB",
  "DELETE_JOB",
  "CREATE_VISIT",
  "UPDATE_VISIT",
  "REPORT_VISIT_COMPLETED",
  "CANCEL_VISIT",
  "REOPEN_VISIT",
  "DELETE_VISIT",
  "SET_ACTIVITY_AMOUNT",
  "ADD_PAYMENT",
  "SET_PAID_TOTAL",
  "SETTLE_BALANCE",
  "MERGE_CUSTOMERS",
  "RESTORE_CUSTOMER",
  "UNDO_ACTION_BATCH",
  "ASK_CLARIFICATION",
  "RESPOND"
] as const;

export const AssistantToolNameSchema = z.enum(ASSISTANT_TOOL_NAMES);
export type AssistantToolName = z.infer<typeof AssistantToolNameSchema>;

export const AssistantStepReferenceSchema = z.object({
  stepId: z.string().trim().min(1),
  outputField: z.literal("entityId")
});
export type AssistantStepReference = z.infer<typeof AssistantStepReferenceSchema>;

const ASSISTANT_ENTITY_OUTPUT_TOOLS = new Set<AssistantToolName>([
  "FIND_CUSTOMERS", "FIND_TASKS", "FIND_JOBS", "FIND_VISITS", "GET_ACTIVITY_AMOUNT",
  "CREATE_CUSTOMER", "UPDATE_CUSTOMER", "ADD_CUSTOMER_PHONE", "UPDATE_CUSTOMER_PHONE", "DELETE_CUSTOMER_PHONE",
  "ADD_SERVICE_ADDRESS", "UPDATE_SERVICE_ADDRESS", "DELETE_SERVICE_ADDRESS",
  "CREATE_TASK", "UPDATE_TASK", "COMPLETE_TASK", "CANCEL_TASK", "REOPEN_TASK", "DELETE_TASK",
  "CREATE_NOTE", "UPDATE_NOTE",
  "CREATE_JOB", "UPDATE_JOB", "REPORT_JOB_COMPLETED", "CANCEL_JOB", "REOPEN_JOB", "DELETE_JOB",
  "CREATE_VISIT", "UPDATE_VISIT", "REPORT_VISIT_COMPLETED", "CANCEL_VISIT", "REOPEN_VISIT", "DELETE_VISIT",
  "SET_ACTIVITY_AMOUNT", "ADD_PAYMENT", "SET_PAID_TOTAL", "SETTLE_BALANCE", "MERGE_CUSTOMERS", "RESTORE_CUSTOMER"
]);

export const AssistantPlanStepSchema = z.object({
  stepId: z.string().trim().min(1),
  kind: z.enum(["READ", "WRITE", "CLARIFY", "RESPOND"]),
  tool: AssistantToolNameSchema,
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  input: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
  requiresExplicitConfirmation: z.boolean()
});
export type AssistantPlanStep = z.infer<typeof AssistantPlanStepSchema>;

export const AssistantReplySchema = z.object({
  completedLead: z.string().trim().min(1).max(100),
  partialLead: z.string().trim().min(1).max(100),
  needsInputLead: z.string().trim().min(1).max(100)
});
export type AssistantReply = z.infer<typeof AssistantReplySchema>;

export const AssistantPlanSchema = z.object({
  version: z.literal("2"),
  requestKind: z.enum(["QUESTION", "ACTION", "MIXED"]),
  language: z.literal("he-IL"),
  extractedFacts: z.record(z.unknown()),
  assistantReply: AssistantReplySchema.optional(),
  steps: z.array(AssistantPlanStepSchema).min(1).max(10)
}).superRefine((plan, context) => {
  const stepIds = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    if (stepIds.has(step.stepId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "stepId"], message: "stepId must be unique" });
    }
    stepIds.add(step.stepId);
  }
  for (const [index, step] of plan.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency) || dependency === step.stepId) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dependsOn"], message: "dependency must reference another step" });
      }
    }
    for (const [inputField, value] of Object.entries(step.input)) {
      if (!inputField.endsWith("Ref")) continue;
      const parsedReference = AssistantStepReferenceSchema.safeParse(value);
      if (!parsedReference.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "input", inputField], message: "step reference must contain stepId and outputField=entityId" });
        continue;
      }
      const referencedIndex = plan.steps.findIndex((candidate) => candidate.stepId === parsedReference.data.stepId);
      const referencedStep = referencedIndex >= 0 ? plan.steps[referencedIndex] : undefined;
      if (!step.dependsOn.includes(parsedReference.data.stepId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "dependsOn"], message: "step reference must be declared as a direct dependency" });
      }
      if (!referencedStep || referencedIndex >= index) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "input", inputField, "stepId"], message: "step reference must point to an earlier step" });
      } else if (!ASSISTANT_ENTITY_OUTPUT_TOOLS.has(referencedStep.tool)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "input", inputField, "stepId"], message: "referenced step does not produce an entityId" });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  };
  if (!plan.steps.every((step) => visit(step.stepId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "step dependencies must not contain cycles" });
  }
});
export type AssistantPlan = z.infer<typeof AssistantPlanSchema>;

export const V2CreateAssistantSessionSchema = z.object({
  clientSessionId: z.string().trim().min(1).max(200)
});
export type V2CreateAssistantSession = z.infer<typeof V2CreateAssistantSessionSchema>;

export const V2AssistantCommandSchema = z.object({
  transcript: z.string().trim().min(2),
  clientSessionId: z.string().trim().min(1).max(200)
});
export type V2AssistantCommand = z.infer<typeof V2AssistantCommandSchema>;

const V2ActivityFieldsSchema = z.object({
  customerId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalTrimmedStringSchema,
  startsAt: OptionalIsoDateSchema,
  endsAt: OptionalIsoDateSchema,
  serviceAddressId: OptionalTrimmedStringSchema,
  locationSnapshot: OptionalTrimmedStringSchema,
  status: V2ActivityStatusSchema.optional(),
  scheduleConflictToken: z.string().trim().min(1).max(4096).optional()
}).strict().superRefine((value, context) => {
  if (value.endsAt && !value.startsAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt requires startsAt" });
  }
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt must be after startsAt" });
  }
});

export const V2CreateJobSchema = V2ActivityFieldsSchema;
export const V2CreateVisitSchema = V2ActivityFieldsSchema;
export type V2CreateJob = z.infer<typeof V2CreateJobSchema>;
export type V2CreateVisit = z.infer<typeof V2CreateVisitSchema>;

export const V2UpdateActivitySchema = z.object({
  customerId: OptionalTrimmedStringSchema,
  title: OptionalTrimmedStringSchema,
  description: NullableTrimmedStringSchema,
  startsAt: NullableIsoDateSchema,
  endsAt: NullableIsoDateSchema,
  serviceAddressId: z.string().trim().min(1).nullable().optional(),
  locationSnapshot: NullableTrimmedStringSchema,
  status: V2ActivityStatusSchema.optional(),
  scheduleConflictToken: z.string().trim().min(1).max(4096).optional(),
  version: V2EntityVersionSchema.optional()
}).strict().refine((value) => Object.keys(value).some((key) => !["version", "scheduleConflictToken"].includes(key)), {
  message: "At least one activity field is required"
});
export type V2UpdateActivity = z.infer<typeof V2UpdateActivitySchema>;

export const V2ScheduleQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true })
}).refine((value) => new Date(value.to) > new Date(value.from), { message: "to must be after from" });

export const V2AvailabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  excludeEntityId: OptionalTrimmedStringSchema
});

export const V2SearchQuerySchema = V2PaginationQuerySchema.extend({
  query: z.string().trim().min(1),
  target: z.enum(["all", "customers", "tasks", "jobs", "visits"]).default("all"),
  status: z.enum(["all", "open", "closed", "cancelled"]).default("all")
});

export const V2PutAmountSchema = z.object({
  totalAmount: V2MoneySchema,
  paidAmount: V2MoneySchema.optional(),
  confirmed: z.boolean().optional()
});
export type V2PutAmount = z.infer<typeof V2PutAmountSchema>;

export const V2UpdateAmountSchema = z.object({
  totalAmount: V2MoneySchema.optional(),
  paidAmount: V2MoneySchema.optional(),
  confirmed: z.boolean().optional(),
  version: V2EntityVersionSchema.optional()
}).refine((value) => value.totalAmount !== undefined || value.paidAmount !== undefined, {
  message: "At least one amount field is required"
});
export type V2UpdateAmount = z.infer<typeof V2UpdateAmountSchema>;

export const V2AddPaymentSchema = z.object({
  mode: V2PaymentModeSchema,
  amount: V2MoneySchema.optional()
}).superRefine((value, context) => {
  if (value.mode !== "SETTLE_BALANCE" && value.amount === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "amount is required for this payment mode" });
  }
});
export type V2AddPayment = z.infer<typeof V2AddPaymentSchema>;

export const V2ReportCompletedSchema = z.object({
  noCharge: z.boolean().optional()
});

export const V2DateRangeQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true })
}).refine((value) => new Date(value.to) > new Date(value.from), { message: "to must be after from" });

export const V2PendingActionsQuerySchema = V2PaginationQuerySchema.extend({
  status: z.enum(["PENDING", "COMPLETED", "REJECTED", "ALL"]).default("PENDING"),
  actionBatchId: z.string().trim().min(1).optional()
});

export const V2UpdatePendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  question: z.string().trim().min(1).optional()
}).refine((value) => value.payload !== undefined || value.question !== undefined, {
  message: "At least one pending action field is required"
});

export const V2ResolvePendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  selectedEntityId: z.string().trim().min(1).optional(),
  confirmed: z.boolean().optional()
});

export const V2UpdateUserPreferencesSchema = z.object({
  assistantResponseMode: AssistantResponseModeSchema
});

export const V2UndoSchema = z.object({
  confirmed: z.literal(true)
});
