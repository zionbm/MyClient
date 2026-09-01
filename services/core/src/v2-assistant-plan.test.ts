import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPlanSchema } from "@myclient/contracts";

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
