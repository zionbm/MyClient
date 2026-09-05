import { AssistantPlanSchema, type AssistantPlan } from "@myclient/contracts";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
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
  for (const [field, fieldValue] of Object.entries(input)) {
    if (fieldValue === null && !(tool === "UPDATE_TASK" && field === "customerId")) delete input[field];
  }
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
  if (["CREATE_NOTE", "UPDATE_NOTE"].includes(tool)) {
    moveAlias(input, "text", ["note", "notes", "description", "generalNotes"]);
  }
  if (tool === "FIND_CUSTOMERS") {
    moveAlias(input, "query", ["name", "customerName", "search"]);
  }
  for (const field of [
    "email",
    "generalNotes",
    "label",
    "description",
    "dueAt",
    "startsAt",
    "endsAt",
    "serviceAddressId",
    "locationSnapshot"
  ]) {
    if (typeof input[field] === "string" && input[field].trim() === "") delete input[field];
  }
  if (
    typeof input.description === "string" &&
    /^(?:עבודה|ביקור)\s+שנקבע[ה]?\s+(?:על\s+ידי|ע["״]?י)\s+המשתמש[.!…]*$/u.test(input.description.trim())
  ) {
    delete input.description;
  }
  return input;
}

function preferCustomerNoteWorkItem(steps: JsonObject[], transcript: string) {
  const asksForNote = /(?:הוסף|הוסיפי|תוסיף|תוסיפי|רשום|רשמי|תרשום|תרשמי)\S*[^.?!]*הערה/u.test(transcript);
  if (!asksForNote) return steps;
  return steps.map((step) => {
    if (step.tool !== "UPDATE_CUSTOMER") return step;
    const input = objectValue(step.input);
    if (typeof input.generalNotes !== "string" || !input.generalNotes.trim()) return step;
    return {
      ...step,
      tool: "CREATE_NOTE",
      input: {
        ...(typeof input.customerId === "string" ? { customerId: input.customerId } : {}),
        ...(typeof input.entityId === "string" ? { customerId: input.entityId } : {}),
        ...(input.customerRef !== undefined ? { customerRef: input.customerRef } : {}),
        ...(input.entityRef !== undefined ? { customerRef: input.entityRef } : {}),
        text: input.generalNotes
      }
    };
  });
}

function preserveTaskCustomerUnlessExplicitlyRemoved(steps: JsonObject[], transcript: string) {
  const removesCustomer = /(?:הסר|הסירי|תסיר|תסירי|נתק|נתקי|תנתק|תנתקי).*(?:לקוח|שיוך)|(?:בלי|ללא)\s+לקוח/u.test(
    transcript
  );
  if (removesCustomer) return steps;
  return steps.map((step) => {
    if (step.tool !== "UPDATE_TASK") return step;
    const input = { ...objectValue(step.input) };
    if (input.customerId === null) delete input.customerId;
    return { ...step, input };
  });
}

function preferExplicitMissingCustomer(steps: JsonObject[], transcript: string) {
  const customerName = /להתקשר\s+ל(.+?)\s+לקוח(?:ה)?\s+לא\s+קיי/u.exec(transcript)?.[1]?.trim();
  if (!customerName || steps.some((step) => step.tool === "FIND_CUSTOMERS")) return steps;
  const taskIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.tool === "CREATE_TASK" &&
        objectValue(step.input).customerId === undefined &&
        objectValue(step.input).customerRef === undefined
    );
  if (taskIndexes.length !== 1 || steps.length >= 10) return steps;
  const findStepId = "find_explicit_missing_customer";
  const taskIndex = taskIndexes[0]!.index;
  return [
    {
      stepId: findStepId,
      kind: "READ",
      tool: "FIND_CUSTOMERS",
      dependsOn: [],
      input: { query: customerName },
      confidence: 1,
      requiresExplicitConfirmation: false
    },
    ...steps.map((step, index) =>
      index === taskIndex
        ? {
            ...step,
            dependsOn: [...new Set([...(Array.isArray(step.dependsOn) ? step.dependsOn : []), findStepId])],
            input: { ...objectValue(step.input), customerRef: { stepId: findStepId, outputField: "entityId" } }
          }
        : step
    )
  ];
}

function isExplicitCustomerCreation(transcript: string) {
  return /(?:לקוח(?:ה)?\s+חדש(?:ה)?|(?:צור|צרי|תיצור|תצרי|הוסף|הוסיפי|תוסיף|תוסיפי)\S*\s+(?:לי\s+)?לקוח)/u.test(
    transcript
  );
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
      const dependencies = Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((value): value is string => typeof value === "string")
        : [];
      const dependsOn =
        step.stepId === createId
          ? dependencies.filter((dependency) => dependency !== findId)
          : [...new Set(dependencies.map((dependency) => (dependency === findId ? createId : dependency)))];
      return { ...step, input, dependsOn };
    });
}

function continueMissingCustomerDecision(context: unknown, transcript: string): AssistantPlan | undefined {
  const pendingActions = Array.isArray(objectValue(context).pendingActions)
    ? (objectValue(context).pendingActions as unknown[]).map(objectValue)
    : [];
  const matchingPending = pendingActions.filter((pending) => pending.actionType === "FIND_CUSTOMERS");
  if (matchingPending.length !== 1) return undefined;
  const pending = matchingPending[0]!;
  const payload = objectValue(pending.payload);
  const suggestion = objectValue(payload.createCustomerSuggestion);
  const customerName = typeof suggestion.name === "string" ? suggestion.name.trim() : "";
  if (!customerName || typeof pending.id !== "string") return undefined;

  const answeredYes = /^(?:כן|בטח|אוקיי|בסדר|צור|צרי|תיצור|תצרי)(?:\s|,|\.|$)/u.test(transcript.trim());
  const answeredNo = /^(?:לא|אל|עזוב|עזבי|בטל|בטלי)(?:\s|,|\.|$)/u.test(transcript.trim());
  if (!answeredYes && !answeredNo) return undefined;
  if (answeredNo) {
    return AssistantPlanSchema.parse({
      version: "2",
      requestKind: "ACTION",
      language: "he-IL",
      extractedFacts: { rejectsPendingActionId: pending.id },
      steps: [
        {
          stepId: "decline_missing_customer_creation",
          kind: "RESPOND",
          tool: "RESPOND",
          dependsOn: [],
          input: { text: `בסדר, לא יצרתי לקוח בשם ${customerName}.` },
          confidence: 1,
          requiresExplicitConfirmation: false
        }
      ]
    });
  }

  const createStepId = "create_missing_customer";
  const continuationSteps = Array.isArray(payload.continuationSteps) ? payload.continuationSteps.map(objectValue) : [];
  const steps: JsonObject[] = [
    {
      stepId: createStepId,
      kind: "WRITE",
      tool: "CREATE_CUSTOMER",
      dependsOn: [],
      input: { name: customerName },
      confidence: 1,
      requiresExplicitConfirmation: false
    }
  ];
  for (const [index, continuation] of continuationSteps.entries()) {
    const input = { ...objectValue(continuation.input) };
    for (const [field, value] of Object.entries(input)) {
      const reference = objectValue(value);
      if (field.endsWith("Ref") && reference.stepId === suggestion.sourceStepId) {
        input[field] = { stepId: createStepId, outputField: "entityId" };
      }
    }
    steps.push({
      ...continuation,
      stepId: typeof continuation.stepId === "string" ? `continue_${continuation.stepId}` : `continue_${index + 1}`,
      dependsOn: [createStepId],
      input,
      requiresExplicitConfirmation: false
    });
  }
  return AssistantPlanSchema.parse({
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { resolvesPendingActionId: pending.id },
    steps
  });
}

function continueConfirmedPendingAction(context: unknown, transcript: string): AssistantPlan | undefined {
  const pendingActions = Array.isArray(objectValue(context).pendingActions)
    ? (objectValue(context).pendingActions as unknown[]).map(objectValue)
    : [];
  const confirmationCandidates = pendingActions.filter((pending) => pending.requiresExplicitConfirmation === true);
  const confirmedPending =
    confirmationCandidates.length === 1 &&
    /(?:^|\s)(?:כן|מאשר|מאשרת|אשר|אשרי|תאשר|תאשרי)(?:\s|,|\.|$)|בכל\s+זאת/u.test(transcript)
      ? confirmationCandidates[0]
      : undefined;
  if (!confirmedPending || typeof confirmedPending.id !== "string") return undefined;
  const payload = objectValue(confirmedPending.payload);
  const tool =
    typeof payload.tool === "string"
      ? payload.tool.toUpperCase()
      : typeof confirmedPending.actionType === "string"
        ? confirmedPending.actionType.toUpperCase()
        : undefined;
  const input = {
    ...objectValue(payload.input),
    ...objectValue(payload.confirmationOverrides)
  };
  return AssistantPlanSchema.parse({
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { resolvesPendingActionId: confirmedPending.id },
    steps: [
      {
        stepId: "continue_confirmed_pending_action",
        kind: "WRITE",
        tool,
        dependsOn: [],
        input: normalizeToolInput(String(tool ?? ""), input),
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  });
}

function continueNoChargeCompletion(context: unknown, transcript: string): AssistantPlan | undefined {
  if (!/(?:לא\s+היה|בלי|אין)\s+חיוב/u.test(transcript)) return undefined;
  const pendingActions = Array.isArray(objectValue(context).pendingActions)
    ? (objectValue(context).pendingActions as unknown[]).map(objectValue)
    : [];
  const candidates = pendingActions.filter(
    (pending) =>
      ["REPORT_JOB_COMPLETED", "REPORT_VISIT_COMPLETED"].includes(String(pending.actionType)) &&
      Array.isArray(pending.missingFields) &&
      pending.missingFields.includes("noChargeOrAmount")
  );
  if (candidates.length !== 1 || typeof candidates[0]!.id !== "string") return undefined;
  const pending = candidates[0]!;
  const payload = objectValue(pending.payload);
  const tool = String(payload.tool ?? pending.actionType);
  return AssistantPlanSchema.parse({
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { resolvesPendingActionId: pending.id },
    steps: [
      {
        stepId: "continue_no_charge_completion",
        kind: "WRITE",
        tool,
        dependsOn: [],
        input: { ...objectValue(payload.input), noCharge: true },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  });
}

export function deterministicPendingAssistantPlan(context: unknown, transcript: string): AssistantPlan | undefined {
  return (
    continueNoChargeCompletion(context, transcript) ??
    continueMissingCustomerDecision(context, transcript) ??
    continueConfirmedPendingAction(context, transcript)
  );
}

export function normalizeAssistantPlan(rawPlan: unknown, context: unknown, transcript: string): AssistantPlan {
  const deterministicPending = deterministicPendingAssistantPlan(context, transcript);
  if (deterministicPending) return deterministicPending;
  const raw = objectValue(rawPlan);
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
  steps = preferExplicitCustomerCreation(steps, transcript);
  steps = preferCustomerNoteWorkItem(steps, transcript);
  steps = preserveTaskCustomerUnlessExplicitlyRemoved(steps, transcript);
  steps = preferExplicitMissingCustomer(steps, transcript);
  return AssistantPlanSchema.parse({ ...raw, steps });
}
