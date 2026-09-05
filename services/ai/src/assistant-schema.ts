import { ASSISTANT_TOOL_NAMES, type AssistantToolName } from "@myclient/contracts";

type JsonSchema = Record<string, unknown>;

const stringValue: JsonSchema = { type: "string" };
const numberValue: JsonSchema = { type: "number" };
const booleanValue: JsonSchema = { type: "boolean" };
const referenceValue: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepId", "outputField"],
  properties: {
    stepId: stringValue,
    outputField: { type: "string", enum: ["entityId"] }
  }
};

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  };
}

const nullableString = nullable(stringValue);
const nullableNumber = nullable(numberValue);
const nullableBoolean = nullable(booleanValue);
const nullableReference = nullable(referenceValue);
const nullableTaskStatus = nullable({ type: "string", enum: ["OPEN", "DONE", "CANCELLED"] });

const customerTarget = {
  customerId: nullableString,
  customerRef: nullableReference
};
const entityTarget = {
  entityId: nullableString,
  entityRef: nullableReference
};

const toolInputs: Record<AssistantToolName, JsonSchema> = {
  FIND_CUSTOMERS: strictObject({ query: stringValue }),
  GET_CUSTOMER_TIMELINE: strictObject(customerTarget),
  FIND_TASKS: strictObject({ ...customerTarget, title: nullableString }),
  FIND_JOBS: strictObject({ ...customerTarget, title: nullableString }),
  FIND_VISITS: strictObject({ ...customerTarget, title: nullableString }),
  GET_ACTIVITY_AMOUNT: strictObject(entityTarget),
  GET_SCHEDULE: strictObject({ from: stringValue, to: stringValue, limit: nullable({ type: "integer", minimum: 1 }) }),
  GET_AVAILABILITY: strictObject({ date: stringValue, durationMinutes: numberValue }),
  GET_PAYMENT_SUMMARY: strictObject({ from: nullableString, to: nullableString }),
  GET_OPEN_BALANCES: strictObject({}),
  GET_TODAY_OVERVIEW: strictObject({ date: nullableString }),
  CREATE_CUSTOMER: strictObject({ name: stringValue, email: nullableString, generalNotes: nullableString }),
  UPDATE_CUSTOMER: strictObject({
    ...customerTarget,
    name: nullableString,
    email: nullableString,
    generalNotes: nullableString
  }),
  ADD_CUSTOMER_PHONE: strictObject({
    ...customerTarget,
    phone: stringValue,
    label: nullableString,
    isPrimary: nullableBoolean
  }),
  UPDATE_CUSTOMER_PHONE: strictObject({
    phoneId: nullableString,
    entityRef: nullableReference,
    phone: nullableString,
    label: nullableString,
    isPrimary: nullableBoolean
  }),
  DELETE_CUSTOMER_PHONE: strictObject({ phoneId: nullableString, entityRef: nullableReference }),
  ADD_SERVICE_ADDRESS: strictObject({ ...customerTarget, addressText: stringValue, label: nullableString }),
  UPDATE_SERVICE_ADDRESS: strictObject({
    addressId: nullableString,
    entityRef: nullableReference,
    addressText: nullableString,
    label: nullableString
  }),
  DELETE_SERVICE_ADDRESS: strictObject({ addressId: nullableString, entityRef: nullableReference }),
  CREATE_TASK: strictObject({
    ...customerTarget,
    title: stringValue,
    description: nullableString,
    dueAt: nullableString,
    status: nullableTaskStatus
  }),
  UPDATE_TASK: strictObject({
    taskId: nullableString,
    entityRef: nullableReference,
    customerId: nullableString,
    title: nullableString,
    description: nullableString,
    dueAt: nullableString,
    status: nullableTaskStatus
  }),
  COMPLETE_TASK: strictObject({ taskId: nullableString, entityRef: nullableReference }),
  CANCEL_TASK: strictObject({ taskId: nullableString, entityRef: nullableReference }),
  REOPEN_TASK: strictObject({ taskId: nullableString, entityRef: nullableReference }),
  DELETE_TASK: strictObject({ taskId: nullableString, entityRef: nullableReference }),
  CREATE_NOTE: strictObject({ ...customerTarget, text: stringValue, status: nullableTaskStatus }),
  UPDATE_NOTE: strictObject({
    noteId: nullableString,
    entityRef: nullableReference,
    text: nullableString,
    status: nullableTaskStatus
  }),
  CREATE_JOB: activityCreateInput(),
  UPDATE_JOB: activityUpdateInput(),
  REPORT_JOB_COMPLETED: strictObject({ ...entityTarget, noCharge: nullableBoolean }),
  CANCEL_JOB: strictObject(entityTarget),
  REOPEN_JOB: strictObject(entityTarget),
  DELETE_JOB: strictObject(entityTarget),
  CREATE_VISIT: activityCreateInput(),
  UPDATE_VISIT: activityUpdateInput(),
  REPORT_VISIT_COMPLETED: strictObject({ ...entityTarget, noCharge: nullableBoolean }),
  CANCEL_VISIT: strictObject(entityTarget),
  REOPEN_VISIT: strictObject(entityTarget),
  DELETE_VISIT: strictObject(entityTarget),
  SET_ACTIVITY_AMOUNT: strictObject({ ...entityTarget, totalAmount: numberValue, paidAmount: nullableNumber }),
  ADD_PAYMENT: strictObject({ ...entityTarget, amount: numberValue }),
  SET_PAID_TOTAL: strictObject({ ...entityTarget, amount: numberValue }),
  SETTLE_BALANCE: strictObject(entityTarget),
  MERGE_CUSTOMERS: strictObject({
    sourceCustomerId: nullableString,
    sourceCustomerRef: nullableReference,
    targetCustomerId: nullableString,
    targetCustomerRef: nullableReference
  }),
  RESTORE_CUSTOMER: strictObject(customerTarget),
  UNDO_ACTION_BATCH: strictObject({ actionBatchId: nullableString }),
  ASK_CLARIFICATION: strictObject({ question: stringValue }),
  RESPOND: strictObject({ text: stringValue })
};

function activityCreateInput(): JsonSchema {
  return strictObject({
    ...customerTarget,
    title: stringValue,
    description: nullableString,
    startsAt: nullableString,
    endsAt: nullableString,
    serviceAddressId: nullableString,
    locationSnapshot: nullableString,
    scheduleConflictToken: nullableString
  });
}

function activityUpdateInput(): JsonSchema {
  return strictObject({
    ...entityTarget,
    title: nullableString,
    description: nullableString,
    startsAt: nullableString,
    endsAt: nullableString,
    serviceAddressId: nullableString,
    locationSnapshot: nullableString,
    scheduleConflictToken: nullableString
  });
}

const readTools = new Set<AssistantToolName>(ASSISTANT_TOOL_NAMES.slice(0, 11));

function stepSchema(tool: AssistantToolName): JsonSchema {
  const kind =
    tool === "ASK_CLARIFICATION" ? "CLARIFY" : tool === "RESPOND" ? "RESPOND" : readTools.has(tool) ? "READ" : "WRITE";
  return strictObject({
    stepId: stringValue,
    kind: { type: "string", enum: [kind] },
    tool: { type: "string", enum: [tool] },
    dependsOn: { type: "array", items: stringValue },
    input: toolInputs[tool],
    confidence: { type: "number", minimum: 0, maximum: 1 },
    requiresExplicitConfirmation: booleanValue
  });
}

export const ASSISTANT_PLAN_JSON_SCHEMA: JsonSchema = strictObject({
  version: { type: "string", enum: ["2"] },
  requestKind: { type: "string", enum: ["QUESTION", "ACTION", "MIXED"] },
  language: { type: "string", enum: ["he-IL"] },
  extractedFacts: strictObject({
    resolvesPendingActionId: nullableString,
    rejectsPendingActionId: nullableString
  }),
  assistantReply: strictObject({
    completedLead: { type: "string", minLength: 1, maxLength: 100 },
    partialLead: { type: "string", minLength: 1, maxLength: 100 },
    needsInputLead: { type: "string", minLength: 1, maxLength: 100 }
  }),
  steps: {
    type: "array",
    minItems: 1,
    maxItems: 10,
    items: { anyOf: ASSISTANT_TOOL_NAMES.map(stepSchema) }
  }
});
