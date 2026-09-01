import { AssistantPlanSchema, type AssistantPlan } from "@myclient/contracts";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstDefined(input: JsonObject, names: string[]) {
  for (const name of names) {
    if (input[name] !== undefined) return input[name];
  }
  return undefined;
}

function moveAlias(input: JsonObject, target: string, aliases: string[]) {
  if (input[target] === undefined) {
    const value = firstDefined(input, aliases);
    if (value !== undefined) input[target] = value;
  }
  for (const alias of aliases) delete input[alias];
}

function normalizeMoney(input: JsonObject, fields: string[]) {
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || !/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) continue;
    input[field] = Number(value.replace(",", "."));
  }
}

function normalizeToolInput(tool: string, value: unknown) {
  const input = { ...objectValue(value) };
  if (["CREATE_JOB", "UPDATE_JOB", "CREATE_VISIT", "UPDATE_VISIT"].includes(tool)) {
    moveAlias(input, "startsAt", ["scheduledStart", "startAt", "startTime"]);
    moveAlias(input, "endsAt", ["scheduledEnd", "endAt", "endTime"]);
    moveAlias(input, "description", ["notes"]);
  }
  if (tool === "SET_ACTIVITY_AMOUNT") {
    moveAlias(input, "totalAmount", ["amount", "total"]);
    normalizeMoney(input, ["totalAmount", "paidAmount"]);
  }
  if (["ADD_PAYMENT", "SET_PAID_TOTAL"].includes(tool)) {
    normalizeMoney(input, ["amount"]);
  }
  if (["CREATE_TASK", "UPDATE_TASK"].includes(tool)) {
    moveAlias(input, "description", ["notes"]);
  }
  if (["CREATE_CUSTOMER", "UPDATE_CUSTOMER"].includes(tool)) {
    moveAlias(input, "generalNotes", ["notes"]);
  }
  if (tool === "FIND_CUSTOMERS") {
    moveAlias(input, "query", ["name", "customerName", "search"]);
  }
  for (const field of ["email", "generalNotes", "label", "description", "dueAt", "startsAt", "endsAt", "serviceAddressId", "locationSnapshot"]) {
    if (typeof input[field] === "string" && input[field].trim() === "") delete input[field];
  }
  return input;
}

function isExplicitCustomerCreation(transcript: string) {
  return /(?:לקוח(?:ה)?\s+חדש(?:ה)?|(?:צור|צרי|תיצור|תצרי|הוסף|הוסיפי|תוסיף|תוסיפי)\S*\s+(?:לי\s+)?לקוח)/u.test(transcript);
}

function resolveExternalReadReferences(steps: JsonObject[], context: unknown) {
  const readResults = objectValue(objectValue(context).readResults);
  const externalStepIds = new Set(Object.keys(readResults));
  if (externalStepIds.size === 0) return steps;

  return steps.map((step) => {
    const input = { ...objectValue(step.input) };
    for (const [field, value] of Object.entries(input)) {
      if (!field.endsWith("Ref")) continue;
      const reference = objectValue(value);
      const stepId = typeof reference.stepId === "string" ? reference.stepId : undefined;
      if (!stepId || !externalStepIds.has(stepId)) continue;
      const entityId = objectValue(readResults[stepId]).entityId;
      if (typeof entityId !== "string" || !entityId) continue;
      input[field === "customerRef" ? "customerId" : "entityId"] = entityId;
      delete input[field];
    }
    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((dependency) => typeof dependency === "string" && !externalStepIds.has(dependency))
      : [];
    return { ...step, input, dependsOn };
  });
}

function preferExplicitCustomerCreation(steps: JsonObject[], transcript: string) {
  if (!isExplicitCustomerCreation(transcript)) return steps;
  const createSteps = steps.filter((step) => step.tool === "CREATE_CUSTOMER");
  const findSteps = steps.filter((step) => step.tool === "FIND_CUSTOMERS");
  if (createSteps.length !== 1 || findSteps.length !== 1) return steps;
  const createId = createSteps[0]!.stepId;
  const findId = findSteps[0]!.stepId;
  if (typeof createId !== "string" || typeof findId !== "string") return steps;

  return steps
    .filter((step) => step.stepId !== findId)
    .map((step) => {
      const input = { ...objectValue(step.input) };
      for (const [field, value] of Object.entries(input)) {
        if (!field.endsWith("Ref")) continue;
        const reference = objectValue(value);
        if (reference.stepId === findId) input[field] = { ...reference, stepId: createId };
      }
      const dependencies = Array.isArray(step.dependsOn) ? step.dependsOn.filter((value): value is string => typeof value === "string") : [];
      const dependsOn = step.stepId === createId
        ? dependencies.filter((dependency) => dependency !== findId)
        : [...new Set(dependencies.map((dependency) => dependency === findId ? createId : dependency))];
      return { ...step, input, dependsOn };
    });
}

export function normalizeAssistantPlan(rawPlan: unknown, context: unknown, transcript: string): AssistantPlan {
  const raw = objectValue(rawPlan);
  const pendingActions = Array.isArray(objectValue(context).pendingActions)
    ? (objectValue(context).pendingActions as unknown[]).map(objectValue)
    : [];
  const confirmedPending = pendingActions.length === 1 && pendingActions[0]!.requiresExplicitConfirmation === true && /(?:^|\s)(?:כן|מאשר|מאשרת|אשר|אשרי|תאשר|תאשרי)(?:\s|,|\.|$)|בכל\s+זאת/u.test(transcript)
    ? pendingActions[0]
    : undefined;
  if (confirmedPending && typeof confirmedPending.id === "string") {
    const payload = objectValue(confirmedPending.payload);
    const tool = typeof payload.tool === "string"
      ? payload.tool.toUpperCase()
      : typeof confirmedPending.actionType === "string" ? confirmedPending.actionType.toUpperCase() : undefined;
    const input = {
      ...objectValue(payload.input),
      ...objectValue(payload.confirmationOverrides)
    };
    return AssistantPlanSchema.parse({
      version: "2",
      requestKind: "ACTION",
      language: "he-IL",
      extractedFacts: { resolvesPendingActionId: confirmedPending.id },
      steps: [{
        stepId: "continue_confirmed_pending_action",
        kind: "WRITE",
        tool,
        dependsOn: [],
        input: normalizeToolInput(String(tool ?? ""), input),
        confidence: 1,
        requiresExplicitConfirmation: false
      }]
    });
  }
  const rawSteps = Array.isArray(raw.steps) ? raw.steps.map(objectValue) : [];
  let steps: JsonObject[] = rawSteps.map((step) => {
    const tool = typeof step.tool === "string" ? step.tool.toUpperCase() : step.tool;
    let kind = typeof step.kind === "string" ? step.kind.toUpperCase() : step.kind;
    if (tool === "ASK_CLARIFICATION") kind = "CLARIFY";
    if (tool === "RESPOND") kind = "RESPOND";
    return {
      ...step,
      tool,
      kind,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      input: normalizeToolInput(String(tool ?? ""), step.input)
    };
  });
  steps = resolveExternalReadReferences(steps, context);
  steps = preferExplicitCustomerCreation(steps, transcript);
  return AssistantPlanSchema.parse({ ...raw, steps });
}
