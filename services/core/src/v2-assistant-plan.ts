import { AssistantPlanSchema, type AssistantPlan, type AssistantPlanStep } from "@myclient/contracts";
import { normalizeCustomerName } from "./v2-normalization.js";

const CORE_CONFIRMATION_TOOLS = new Set<AssistantPlanStep["tool"]>([
  "CANCEL_TASK",
  "CANCEL_JOB",
  "CANCEL_VISIT",
  "DELETE_CUSTOMER_PHONE",
  "DELETE_SERVICE_ADDRESS",
  "DELETE_TASK",
  "DELETE_JOB",
  "DELETE_VISIT",
  "SET_ACTIVITY_AMOUNT",
  "ADD_PAYMENT",
  "SET_PAID_TOTAL",
  "SETTLE_BALANCE",
  "MERGE_CUSTOMERS",
  "UNDO_ACTION_BATCH"
]);

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function materializeStepReferences(step: AssistantPlanStep, outputs: Map<string, Record<string, unknown>>) {
  const input = { ...step.input };
  const entityIdField = step.tool.includes("TASK") ? "taskId"
    : step.tool.includes("NOTE") ? "noteId"
      : step.tool.includes("CUSTOMER_PHONE") ? "phoneId"
        : step.tool.includes("SERVICE_ADDRESS") ? "addressId"
          : "entityId";
  const referenceTargets: Record<string, string> = {
    customerRef: "customerId",
    entityRef: entityIdField,
    sourceCustomerRef: "sourceCustomerId",
    targetCustomerRef: "targetCustomerId"
  };
  for (const [referenceField, targetField] of Object.entries(referenceTargets)) {
    const reference = objectValue(input[referenceField]);
    const output = typeof reference.stepId === "string" ? outputs.get(reference.stepId) : undefined;
    if (typeof output?.entityId !== "string") continue;
    input[targetField] = output.entityId;
    delete input[referenceField];
  }
  return input;
}

export function assistantToolRequiresConfirmation(tool: AssistantPlanStep["tool"]) {
  return CORE_CONFIRMATION_TOOLS.has(tool);
}

export function applyAssistantConfirmationPolicy(
  plan: AssistantPlan,
  confirmedPendingActionId?: string
) {
  const resolvesConfirmedPending = confirmedPendingActionId !== undefined
    && plan.extractedFacts.resolvesPendingActionId === confirmedPendingActionId;
  return AssistantPlanSchema.parse({
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      requiresExplicitConfirmation: step.requiresExplicitConfirmation
        || (!resolvesConfirmedPending && assistantToolRequiresConfirmation(step.tool))
    }))
  });
}

export function preferTranscriptCustomerName(
  plan: AssistantPlan,
  transcript: string,
  customers: Array<{ name: string; normalizedName: string | null }>
) {
  const findSteps = plan.steps.filter((step) => step.tool === "FIND_CUSTOMERS");
  if (findSteps.length !== 1) return plan;
  const normalizedTranscript = normalizeCustomerName(transcript);
  const mentioned = customers
    .map((customer) => ({ ...customer, normalizedName: customer.normalizedName ?? normalizeCustomerName(customer.name) }))
    .filter((customer) => normalizedTranscript.includes(customer.normalizedName))
    .sort((left, right) => right.normalizedName.length - left.normalizedName.length);
  if (mentioned.length === 0) return plan;
  const longest = mentioned[0]!;
  if (mentioned[1]?.normalizedName.length === longest.normalizedName.length
    && mentioned[1].normalizedName !== longest.normalizedName) return plan;
  return AssistantPlanSchema.parse({
    ...plan,
    steps: plan.steps.map((step) => step.tool === "FIND_CUSTOMERS"
      ? { ...step, input: { ...step.input, query: longest.name } }
      : step)
  });
}

export function stepsBlockedByPlannedClarification(steps: AssistantPlanStep[]) {
  const adjacency = new Map(steps.map((step) => [step.stepId, new Set<string>()]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      adjacency.get(step.stepId)?.add(dependency);
      adjacency.get(dependency)?.add(step.stepId);
    }
  }
  const blocked = new Set<string>();
  const queue = steps.filter((step) => step.kind === "CLARIFY").map((step) => step.stepId);
  for (const stepId of queue) blocked.add(stepId);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const related of adjacency.get(current) ?? []) {
      if (blocked.has(related)) continue;
      blocked.add(related);
      queue.push(related);
    }
  }
  return blocked;
}
