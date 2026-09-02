import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPlanSchema } from "@myclient/contracts";
import { planNeedsReadResolution, stepsBlockedByPlannedClarification, summaryIsGrounded } from "./v2-assistant-plan.js";

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

test("a pure read question does not require a second planning round", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    requestKind: "QUESTION",
    steps: [
      { stepId: "today", kind: "READ", tool: "GET_TODAY_OVERVIEW", dependsOn: [], input: { date: "2026-09-02" }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  assert.equal(planNeedsReadResolution(plan), false);
});

test("a write that depends on a lookup still requires read resolution", () => {
  const plan = AssistantPlanSchema.parse({
    ...basePlan,
    steps: [
      { stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", dependsOn: [], input: { query: "נועה" }, confidence: 1, requiresExplicitConfirmation: false },
      { stepId: "task", kind: "WRITE", tool: "CREATE_TASK", dependsOn: ["find"], input: { title: "לחזור", customerRef: { stepId: "find", outputField: "entityId" } }, confidence: 1, requiresExplicitConfirmation: false }
    ]
  });
  assert.equal(planNeedsReadResolution(plan), true);
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

test("grounded summary rejects amounts absent from the receipt", () => {
  const receipt = { steps: [{ status: "COMPLETED", totalAmount: 500 }] };
  assert.equal(summaryIsGrounded("נשמרו 500 שקלים", receipt), true);
  assert.equal(summaryIsGrounded("נשמרו 700 שקלים", receipt), false);
});

test("grounded summary must preserve scheduling warnings", () => {
  const receipt = { steps: [{ warnings: ["הפעילות נקבעה מחוץ לשעות העבודה."] }] };
  assert.equal(summaryIsGrounded("הפעולה בוצעה בהצלחה.", receipt), false);
  assert.equal(summaryIsGrounded("הפעולה בוצעה. הפעילות נקבעה מחוץ לשעות העבודה.", receipt), true);
});

test("grounded summary never exposes internal UUIDs", () => {
  const receipt = { steps: [{ entityId: "4155ee63-34d9-46d0-a77e-1b8f37d24548", status: "COMPLETED" }] };
  assert.equal(summaryIsGrounded("הלקוחה נוצרה בהצלחה.", receipt), true);
  assert.equal(summaryIsGrounded("הלקוחה נוצרה: 4155ee63-34d9-46d0-a77e-1b8f37d24548", receipt), false);
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
