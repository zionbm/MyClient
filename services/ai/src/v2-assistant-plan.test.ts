import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAssistantPlan } from "./v2-assistant-plan.js";

const basePlan = {
  version: "2",
  requestKind: "ACTION",
  language: "he-IL",
  extractedFacts: {}
};

function step(overrides: Record<string, unknown>) {
  return {
    stepId: "step",
    kind: "WRITE",
    tool: "CREATE_TASK",
    dependsOn: [],
    input: { title: "לחזור ללקוח" },
    confidence: 0.9,
    requiresExplicitConfirmation: false,
    ...overrides
  };
}

test("normalizes clarification kind and known activity/amount aliases", () => {
  const plan = normalizeAssistantPlan({
    ...basePlan,
    steps: [
      step({ stepId: "question", kind: "ASK_CLARIFICATION", tool: "ASK_CLARIFICATION", input: { question: "מה הסכום?" } }),
      step({ stepId: "visit", tool: "CREATE_VISIT", input: { customerId: "customer-1", title: "ביקור", description: "", scheduledStart: "2026-09-02T10:00:00+03:00", scheduledEnd: "2026-09-02T11:00:00+03:00" } }),
      step({ stepId: "amount", tool: "SET_ACTIVITY_AMOUNT", input: { entityId: "visit-1", amount: 500, paidAmount: "200" } })
    ]
  }, {}, "צור ביקור");

  assert.equal(plan.steps[0]!.kind, "CLARIFY");
  assert.equal(plan.steps[1]!.input.startsAt, "2026-09-02T10:00:00+03:00");
  assert.equal(plan.steps[1]!.input.endsAt, "2026-09-02T11:00:00+03:00");
  assert.equal(plan.steps[1]!.input.description, undefined);
  assert.equal(plan.steps[2]!.input.totalAmount, 500);
  assert.equal(plan.steps[2]!.input.paidAmount, 200);
  assert.equal(plan.steps[2]!.input.amount, undefined);
});

test("materializes references to read results from the first planning round", () => {
  const plan = normalizeAssistantPlan({
    ...basePlan,
    steps: [step({
      stepId: "update",
      tool: "UPDATE_CUSTOMER",
      dependsOn: ["find_customer"],
      input: { entityRef: { stepId: "find_customer", outputField: "entityId" }, name: "מאיה לוי" }
    })]
  }, { readResults: { find_customer: { entityId: "customer-1" } } }, "עדכן את מאיה");

  assert.deepEqual(plan.steps[0]!.dependsOn, []);
  assert.equal(plan.steps[0]!.input.entityId, "customer-1");
  assert.equal(plan.steps[0]!.input.entityRef, undefined);
});

test("explicit customer creation removes an unnecessary lookup and retargets dependents", () => {
  const plan = normalizeAssistantPlan({
    ...basePlan,
    steps: [
      step({ stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", input: { name: "נועה כהן" } }),
      step({ stepId: "create", tool: "CREATE_CUSTOMER", dependsOn: ["find"], input: { name: "נועה כהן" } }),
      step({ stepId: "phone", tool: "ADD_CUSTOMER_PHONE", dependsOn: ["find"], input: { customerRef: { stepId: "find", outputField: "entityId" }, phone: "0501234567" } })
    ]
  }, {}, "תיצור לי לקוח חדש בשם נועה כהן ותוסיף טלפון");

  assert.deepEqual(plan.steps.map((item) => item.stepId), ["create", "phone"]);
  assert.deepEqual(plan.steps[0]!.dependsOn, []);
  assert.deepEqual(plan.steps[1]!.dependsOn, ["create"]);
  assert.deepEqual(plan.steps[1]!.input.customerRef, { stepId: "create", outputField: "entityId" });
});

test("normalizes the LLM search alias used by customer lookup", () => {
  const plan = normalizeAssistantPlan({
    ...basePlan,
    steps: [step({ stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", input: { search: "מאיה לוי" } })]
  }, {}, "מצא את מאיה לוי");
  assert.equal(plan.steps[0]!.input.query, "מאיה לוי");
  assert.equal(plan.steps[0]!.input.search, undefined);
});

test("explicit speech confirmation continues the sole pending action with its signed override", () => {
  const plan = normalizeAssistantPlan({ ...basePlan, steps: [step({})] }, {
    pendingActions: [{
      id: "pending-1",
      actionType: "CREATE_VISIT",
      requiresExplicitConfirmation: true,
      payload: {
        tool: "CREATE_VISIT",
        input: { customerId: "customer-1", title: "בדיקה", startsAt: "2026-09-02T14:30:00+03:00", endsAt: "2026-09-02T15:00:00+03:00" },
        confirmationOverrides: { scheduleConflictToken: "signed-token" }
      }
    }]
  }, "כן, תאשר לקבוע בכל זאת במועד שביקשתי");

  assert.equal(plan.extractedFacts.resolvesPendingActionId, "pending-1");
  assert.equal(plan.steps[0]!.tool, "CREATE_VISIT");
  assert.equal(plan.steps[0]!.input.scheduleConflictToken, "signed-token");
  assert.equal(plan.steps[0]!.requiresExplicitConfirmation, false);
});

test("a spoken yes creates a missing customer and continues the blocked task", () => {
  const plan = normalizeAssistantPlan({ ...basePlan, steps: [step({})] }, {
    pendingActions: [{
      id: "pending-customer",
      actionType: "FIND_CUSTOMERS",
      payload: {
        createCustomerSuggestion: { name: "ג׳ק", sourceStepId: "find_customer" },
        continuationSteps: [{
          stepId: "create_task",
          kind: "WRITE",
          tool: "CREATE_TASK",
          dependsOn: ["find_customer"],
          input: {
            title: "להתקשר לג׳ק",
            customerRef: { stepId: "find_customer", outputField: "entityId" }
          },
          confidence: 1,
          requiresExplicitConfirmation: false
        }]
      }
    }]
  }, "כן");

  assert.equal(plan.extractedFacts.resolvesPendingActionId, "pending-customer");
  assert.deepEqual(plan.steps.map((item) => item.tool), ["CREATE_CUSTOMER", "CREATE_TASK"]);
  assert.deepEqual(plan.steps[1]!.input.customerRef, {
    stepId: "create_missing_customer",
    outputField: "entityId"
  });
});

test("a spoken no rejects the missing customer suggestion", () => {
  const plan = normalizeAssistantPlan({ ...basePlan, steps: [step({})] }, {
    pendingActions: [{
      id: "pending-customer",
      actionType: "FIND_CUSTOMERS",
      payload: {
        createCustomerSuggestion: { name: "ג׳ק", sourceStepId: "find_customer" }
      }
    }]
  }, "לא תודה");

  assert.equal(plan.extractedFacts.rejectsPendingActionId, "pending-customer");
  assert.equal(plan.steps[0]!.tool, "RESPOND");
  assert.match(String(plan.steps[0]!.input.text), /לא יצרתי לקוח בשם ג׳ק/);
});
