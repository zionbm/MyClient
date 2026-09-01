import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPlanSchema } from "@myclient/contracts";
import { stepsBlockedByPlannedClarification, summaryIsGrounded } from "./v2-assistant-plan.js";

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
