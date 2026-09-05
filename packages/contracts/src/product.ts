import { z } from "zod";

export const TaskStatusValueSchema = z.enum(["OPEN", "DONE", "CANCELLED"]);
export type TaskStatusValue = z.infer<typeof TaskStatusValueSchema>;

export const ActivityStatusValueSchema = z.enum(["OPEN", "CLOSED", "CANCELLED"]);
export type ActivityStatusValue = z.infer<typeof ActivityStatusValueSchema>;

export const PaymentStatusValueSchema = z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]);
export type PaymentStatusValue = z.infer<typeof PaymentStatusValueSchema>;

export const AmountEventTypeValueSchema = z.enum([
  "CREATE",
  "ADD_PAYMENT",
  "SET_PAID_TOTAL",
  "SETTLE_BALANCE",
  "CHANGE_TOTAL",
  "CORRECTION",
  "UNDO"
]);
export type AmountEventTypeValue = z.infer<typeof AmountEventTypeValueSchema>;

export const PaymentModeSchema = z.enum(["ADD", "SET_PAID_TOTAL", "SETTLE_BALANCE"]);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const PendingStatusSchema = z.enum(["PENDING", "COMPLETED", "REJECTED"]);
export type PendingStatus = z.infer<typeof PendingStatusSchema>;

export const ActionBatchStatusValueSchema = z.enum(["COMPLETED", "PARTIALLY_COMPLETED", "WAITING", "FAILED", "UNDONE"]);
export type ActionBatchStatusValue = z.infer<typeof ActionBatchStatusValueSchema>;

export const AssistantResponseModeSchema = z.enum(["TEXT_ONLY", "TEXT_AND_VOICE"]);
export type AssistantResponseMode = z.infer<typeof AssistantResponseModeSchema>;

export const CurrencySchema = z.literal("ILS");
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.coerce.number().finite().min(0).multipleOf(0.01);
export type Money = z.infer<typeof MoneySchema>;

export const CursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional()
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

const OptionalQueryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

export const TaskListQuerySchema = CursorPaginationQuerySchema.extend({
  state: z.enum(["OPEN", "CLOSED"]).optional(),
  customerId: z.string().trim().min(1).optional(),
  dueBefore: z.string().datetime({ offset: true }).optional(),
  includeUndated: OptionalQueryBooleanSchema
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const ActivityListQuerySchema = CursorPaginationQuerySchema.extend({
  status: ActivityStatusValueSchema.optional(),
  customerId: z.string().trim().min(1).optional(),
  scheduled: OptionalQueryBooleanSchema,
  executed: OptionalQueryBooleanSchema
});
export type ActivityListQuery = z.infer<typeof ActivityListQuerySchema>;

export const IdempotencyKeySchema = z.string().trim().min(1).max(200);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const EntityVersionSchema = z.number().int().positive();
export type EntityVersion = z.infer<typeof EntityVersionSchema>;

const OptionalTrimmedStringSchema = z.string().trim().min(1).optional();
const NullableTrimmedStringSchema = z.string().trim().min(1).nullable().optional();
const OptionalIsoDateSchema = z.string().datetime({ offset: true }).optional();
const NullableIsoDateSchema = z.string().datetime({ offset: true }).nullable().optional();

export const CreateCustomerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  generalNotes: OptionalTrimmedStringSchema
});
export type CreateCustomer = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = z
  .object({
    name: OptionalTrimmedStringSchema,
    email: z.string().trim().email().nullable().optional(),
    generalNotes: NullableTrimmedStringSchema,
    version: EntityVersionSchema.optional()
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "At least one customer field is required"
  });
export type UpdateCustomer = z.infer<typeof UpdateCustomerSchema>;

export const CreateCustomerPhoneSchema = z.object({
  phone: z.string().trim().min(1),
  label: OptionalTrimmedStringSchema,
  isPrimary: z.boolean().optional()
});
export type CreateCustomerPhone = z.infer<typeof CreateCustomerPhoneSchema>;

export const UpdateCustomerPhoneSchema = z
  .object({
    phone: OptionalTrimmedStringSchema,
    label: NullableTrimmedStringSchema,
    isPrimary: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one phone field is required"
  });
export type UpdateCustomerPhone = z.infer<typeof UpdateCustomerPhoneSchema>;

export const CreateServiceAddressSchema = z.object({
  label: OptionalTrimmedStringSchema,
  addressText: z.string().trim().min(1)
});
export type CreateServiceAddress = z.infer<typeof CreateServiceAddressSchema>;

export const UpdateServiceAddressSchema = z
  .object({
    label: NullableTrimmedStringSchema,
    addressText: OptionalTrimmedStringSchema
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one address field is required"
  });
export type UpdateServiceAddress = z.infer<typeof UpdateServiceAddressSchema>;

export const CreateTaskSchema = z.object({
  customerId: OptionalTrimmedStringSchema,
  title: z.string().trim().min(1),
  description: OptionalTrimmedStringSchema,
  dueAt: OptionalIsoDateSchema,
  status: TaskStatusValueSchema.optional()
});
export type CreateTask = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z
  .object({
    customerId: z.string().trim().min(1).nullable().optional(),
    title: OptionalTrimmedStringSchema,
    description: NullableTrimmedStringSchema,
    dueAt: NullableIsoDateSchema,
    status: TaskStatusValueSchema.optional(),
    version: EntityVersionSchema.optional()
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "At least one task field is required"
  });
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

export const CreateNoteSchema = z.object({
  text: z.string().trim().min(1),
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional()
});
export type CreateNote = z.infer<typeof CreateNoteSchema>;

export const UpdateNoteSchema = z
  .object({
    text: OptionalTrimmedStringSchema,
    status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one note field is required"
  });
export type UpdateNote = z.infer<typeof UpdateNoteSchema>;

export const ConfirmedMutationSchema = z.object({
  confirmed: z.literal(true)
});
export type ConfirmedMutation = z.infer<typeof ConfirmedMutationSchema>;

export const MergeCustomerSchema = ConfirmedMutationSchema.extend({
  targetCustomerId: z.string().trim().min(1)
});
export type MergeCustomer = z.infer<typeof MergeCustomerSchema>;

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
  "FIND_CUSTOMERS",
  "FIND_TASKS",
  "FIND_JOBS",
  "FIND_VISITS",
  "GET_ACTIVITY_AMOUNT",
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
  "RESTORE_CUSTOMER"
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

export const AssistantPlanSchema = z
  .object({
    version: z.literal("2"),
    requestKind: z.enum(["QUESTION", "ACTION", "MIXED"]),
    language: z.literal("he-IL"),
    extractedFacts: z.record(z.unknown()),
    assistantReply: AssistantReplySchema.optional(),
    steps: z.array(AssistantPlanStepSchema).min(1).max(10)
  })
  .superRefine((plan, context) => {
    const stepIds = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (stepIds.has(step.stepId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "stepId"],
          message: "stepId must be unique"
        });
      }
      stepIds.add(step.stepId);
    }
    for (const [index, step] of plan.steps.entries()) {
      for (const dependency of step.dependsOn) {
        if (!stepIds.has(dependency) || dependency === step.stepId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "dependsOn"],
            message: "dependency must reference another step"
          });
        }
      }
      for (const [inputField, value] of Object.entries(step.input)) {
        if (!inputField.endsWith("Ref")) continue;
        const parsedReference = AssistantStepReferenceSchema.safeParse(value);
        if (!parsedReference.success) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "input", inputField],
            message: "step reference must contain stepId and outputField=entityId"
          });
          continue;
        }
        const referencedIndex = plan.steps.findIndex((candidate) => candidate.stepId === parsedReference.data.stepId);
        const referencedStep = referencedIndex >= 0 ? plan.steps[referencedIndex] : undefined;
        if (!step.dependsOn.includes(parsedReference.data.stepId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "dependsOn"],
            message: "step reference must be declared as a direct dependency"
          });
        }
        if (!referencedStep || referencedIndex >= index) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "input", inputField, "stepId"],
            message: "step reference must point to an earlier step"
          });
        } else if (!ASSISTANT_ENTITY_OUTPUT_TOOLS.has(referencedStep.tool)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "input", inputField, "stepId"],
            message: "referenced step does not produce an entityId"
          });
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
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "step dependencies must not contain cycles"
      });
    }
  });
export type AssistantPlan = z.infer<typeof AssistantPlanSchema>;

export const CreateAssistantSessionSchema = z.object({
  clientSessionId: z.string().trim().min(1).max(200)
});
export type CreateAssistantSession = z.infer<typeof CreateAssistantSessionSchema>;

export const AssistantCommandSchema = z.object({
  transcript: z.string().trim().min(2),
  clientSessionId: z.string().trim().min(1).max(200)
});
export type AssistantCommand = z.infer<typeof AssistantCommandSchema>;

const ActivityFieldsSchema = z
  .object({
    customerId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: OptionalTrimmedStringSchema,
    startsAt: OptionalIsoDateSchema,
    endsAt: OptionalIsoDateSchema,
    serviceAddressId: OptionalTrimmedStringSchema,
    locationSnapshot: OptionalTrimmedStringSchema,
    status: ActivityStatusValueSchema.optional(),
    scheduleConflictToken: z.string().trim().min(1).max(4096).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsAt && !value.startsAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt requires startsAt" });
    }
    if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
  });

export const CreateJobSchema = ActivityFieldsSchema;
export const CreateVisitSchema = ActivityFieldsSchema;
export type CreateJob = z.infer<typeof CreateJobSchema>;
export type CreateVisit = z.infer<typeof CreateVisitSchema>;

export const UpdateActivitySchema = z
  .object({
    customerId: OptionalTrimmedStringSchema,
    title: OptionalTrimmedStringSchema,
    description: NullableTrimmedStringSchema,
    startsAt: NullableIsoDateSchema,
    endsAt: NullableIsoDateSchema,
    serviceAddressId: z.string().trim().min(1).nullable().optional(),
    locationSnapshot: NullableTrimmedStringSchema,
    status: ActivityStatusValueSchema.optional(),
    scheduleConflictToken: z.string().trim().min(1).max(4096).optional(),
    version: EntityVersionSchema.optional()
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => !["version", "scheduleConflictToken"].includes(key)), {
    message: "At least one activity field is required"
  });
export type UpdateActivity = z.infer<typeof UpdateActivitySchema>;

export const ScheduleQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true })
  })
  .refine((value) => new Date(value.to) > new Date(value.from), { message: "to must be after from" });

export const AvailabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  excludeEntityId: OptionalTrimmedStringSchema
});

export const SearchQuerySchema = CursorPaginationQuerySchema.extend({
  query: z.string().trim().min(1),
  target: z.enum(["all", "customers", "tasks", "jobs", "visits"]).default("all"),
  status: z.enum(["all", "open", "closed", "cancelled"]).default("all")
});

export const PutAmountSchema = z.object({
  totalAmount: MoneySchema,
  paidAmount: MoneySchema.optional(),
  confirmed: z.boolean().optional()
});
export type PutAmount = z.infer<typeof PutAmountSchema>;

export const UpdateAmountSchema = z
  .object({
    totalAmount: MoneySchema.optional(),
    paidAmount: MoneySchema.optional(),
    confirmed: z.boolean().optional(),
    version: EntityVersionSchema.optional()
  })
  .refine((value) => value.totalAmount !== undefined || value.paidAmount !== undefined, {
    message: "At least one amount field is required"
  });
export type UpdateAmount = z.infer<typeof UpdateAmountSchema>;

export const AddPaymentSchema = z
  .object({
    mode: PaymentModeSchema,
    amount: MoneySchema.optional()
  })
  .superRefine((value, context) => {
    if (value.mode !== "SETTLE_BALANCE" && value.amount === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "amount is required for this payment mode"
      });
    }
  });
export type AddPayment = z.infer<typeof AddPaymentSchema>;

export const ReportCompletedSchema = z.object({
  noCharge: z.boolean().optional()
});

export const DateRangeQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true })
  })
  .refine((value) => new Date(value.to) > new Date(value.from), { message: "to must be after from" });

export const PendingActionsQuerySchema = CursorPaginationQuerySchema.extend({
  status: z.enum(["PENDING", "COMPLETED", "REJECTED", "ALL"]).default("PENDING"),
  actionBatchId: z.string().trim().min(1).optional()
});

export const UpdatePendingActionSchema = z
  .object({
    payload: z.record(z.unknown()).optional(),
    question: z.string().trim().min(1).optional()
  })
  .refine((value) => value.payload !== undefined || value.question !== undefined, {
    message: "At least one pending action field is required"
  });

export const ResolvePendingActionSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  selectedEntityId: z.string().trim().min(1).optional(),
  confirmed: z.boolean().optional()
});

export const UpdateUserPreferencesSchema = z.object({
  assistantResponseMode: AssistantResponseModeSchema
});

export const UndoSchema = z.object({
  confirmed: z.literal(true)
});
