import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPlanSchema } from "@myclient/contracts";
import { applyAssistantConfirmationPolicy, materializeStepReferences, preferTranscriptCustomerName, stepsBlockedByPlannedClarification } from "./v2-assistant-plan.js";

const basePlan = {
  version: "2" as const,
  requestKind: "ACTION" as const,
  language: "he-IL" as const,
  extractedFacts: {}
};

test("AssistantPlan accepts an ordered customer-to-task reference", () => {
  const result = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [
      {
        stepId: "customer",
        kind: "WRITE",
        tool: "CREATE_CUSTOMER",
        dependsOn: [],
        input: { name: "נועה כהן" },
        confidence: 0.95,
        requiresExplicitConfirmation: false
      },
      {
        stepId: "task",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: ["customer"],
        input: { title: "לחזור מחר", customerRef: { stepId: "customer", outputField: "entityId" } },
        confidence: 0.9,
        requiresExplicitConfirmation: false
      }
    ]
  });
  assert.equal(result.steps.length, 2);
});

test("AssistantPlan accepts two direct lookup references for a customer merge", () => {
  const result = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [
      { stepId: "source", kind: "READ", tool: "FIND_CUSTOMERS", dependsOn: [], input: { query: "נועה" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "target", kind: "READ", tool: "FIND_CUSTOMERS", dependsOn: [], input: { query: "מאיה" }, confidence: 1, requiresExplicitConfirmation: false },
      {
        stepId: "merge",
        kind: "WRITE",
        tool: "MERGE_CUSTOMERS",
        dependsOn: ["source", "target"],
        input: {
          sourceCustomerRef: { stepId: "source", outputField: "entityId" },
          targetCustomerRef: { stepId: "target", outputField: "entityId" }
        },
        confidence: 1,
        requiresExplicitConfirmation: true
      }
    ]
  });
  assert.equal(result.steps[2]?.tool, "MERGE_CUSTOMERS");
});

test("confirmation payloads materialize references from the same plan", () => {
  const step = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [{
      stepId: "find",
      kind: "READ",
      tool: "FIND_TASKS",
      dependsOn: [],
      input: { title: "לחזור" },
      confidence: 1,
      requiresExplicitConfirmation: false
    }, {
      stepId: "delete",
      kind: "WRITE",
      tool: "DELETE_TASK",
      dependsOn: ["find"],
      input: { entityRef: { stepId: "find", outputField: "entityId" } },
      confidence: 1,
      requiresExplicitConfirmation: true
    }]
  }).steps[1]!;
  const materialized = materializeStepReferences(step, new Map([["find", { entityId: "task-1" }]]));
  assert.deepEqual(materialized, { taskId: "task-1" });
});

test("Core enforces confirmation for cancellation and financial writes", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [
      { stepId: "cancel", kind: "WRITE", tool: "CANCEL_VISIT", dependsOn: [], input: { entityId: "visit-1" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "payment", kind: "WRITE", tool: "ADD_PAYMENT", dependsOn: [], input: { entityId: "visit-1", amount: 200 }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "safe", kind: "WRITE", tool: "UPDATE_VISIT", dependsOn: [], input: { entityId: "visit-1", title: "בדיקה" }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  const enforced = applyAssistantConfirmationPolicy(plan);
  assert.equal(enforced.steps[0]!.requiresExplicitConfirmation, true);
  assert.equal(enforced.steps[1]!.requiresExplicitConfirmation, true);
  assert.equal(enforced.steps[2]!.requiresExplicitConfirmation, false);
});

test("Core does not request a second confirmation for the pending action being resolved", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    extractedFacts: { resolvesPendingActionId: "pending-1" },
    steps: [{ stepId: "payment", kind: "WRITE", tool: "ADD_PAYMENT", dependsOn: [], input: { entityId: "visit-1", amount: 200 }, confidence: 1, requiresExplicitConfirmation: false }]
  });
  const enforced = applyAssistantConfirmationPolicy(plan, "pending-1");
  assert.equal(enforced.steps[0]!.requiresExplicitConfirmation, false);
});

test("Core preserves the longest existing customer name explicitly spoken by the user", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [{ stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", dependsOn: [], input: { query: "אורי לביא" }, confidence: 1, requiresExplicitConfirmation: false }]
  });
  const normalized = preferTranscriptCustomerName(
    plan,
    "אורי לביא לקוח בדיקה שילם על העבודה",
    [
      { name: "אורי לביא", normalizedName: "אורי לביא" },
      { name: "אורי לביא לקוח בדיקה", normalizedName: "אורי לביא לקוח בדיקה" }
    ]
  );
  assert.equal(normalized.steps[0]!.input.query, "אורי לביא לקוח בדיקה");
});

test("AssistantPlan rejects arbitrary reference output fields", () => {
  const result = AssistantPlanSchema.safeParse({
    ...basePlan,
    steps: [
      { stepId: "customer", kind: "WRITE", tool: "CREATE_CUSTOMER", dependsOn: [], input: { name: "נועה" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "task", kind: "WRITE", tool: "CREATE_TASK", dependsOn: ["customer"], input: { title: "לחזור", customerRef: { stepId: "customer", outputField: "customer.id" } }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  assert.equal(result.success, false);
});

test("AssistantPlan requires references to be direct dependencies", () => {
  const result = AssistantPlanSchema.safeParse({
    ...basePlan,
    steps: [
      { stepId: "customer", kind: "WRITE", tool: "CREATE_CUSTOMER", dependsOn: [], input: { name: "נועה" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "task", kind: "WRITE", tool: "CREATE_TASK", dependsOn: [], input: { title: "לחזור", customerRef: { stepId: "customer", outputField: "entityId" } }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  assert.equal(result.success, false);
});

test("AssistantPlan rejects references to non-entity and later steps", () => {
  const nonEntity = AssistantPlanSchema.safeParse({
    ...basePlan,
    steps: [
      { stepId: "availability", kind: "READ", tool: "GET_AVAILABILITY", dependsOn: [], input: { date: "2026-09-02", durationMinutes: 60 }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "task", kind: "WRITE", tool: "CREATE_TASK", dependsOn: ["availability"], input: { title: "לחזור", entityRef: { stepId: "availability", outputField: "entityId" } }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  const later = AssistantPlanSchema.safeParse({
    ...basePlan,
    steps: [
      { stepId: "task", kind: "WRITE", tool: "CREATE_TASK", dependsOn: ["customer"], input: { title: "לחזור", customerRef: { stepId: "customer", outputField: "entityId" } }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "customer", kind: "WRITE", tool: "CREATE_CUSTOMER", dependsOn: [], input: { name: "נועה" }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  assert.equal(nonEntity.success, false);
  assert.equal(later.success, false);
});

test("AssistantPlan rejects dependency cycles", () => {
  const result = AssistantPlanSchema.safeParse({
    ...basePlan,
    steps: [
      {
        stepId: "a",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: ["b"],
        input: { title: "א" },
        confidence: 1,
        requiresExplicitConfirmation: false
      },
      {
        stepId: "b",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: ["a"],
        input: { title: "ב" },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  });
  assert.equal(result.success, false);
});

test("planned clarification blocks only its dependent component", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [
      { stepId: "safe", kind: "WRITE", tool: "CREATE_TASK", dependsOn: [], input: { title: "עצמאית" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "question", kind: "CLARIFY", tool: "ASK_CLARIFICATION", dependsOn: [], input: { question: "איזה לקוח?" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "dependent", kind: "WRITE", tool: "CREATE_JOB", dependsOn: ["question"], input: { title: "תלויה" }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  const blocked = stepsBlockedByPlannedClarification(plan.steps);
  assert.equal(blocked.has("dependent"), true);
  assert.equal(blocked.has("safe"), false);
});
