import assert from "node:assert/strict";
import test from "node:test";
import { deterministicPendingAssistantPlan, normalizeAssistantPlan } from "./assistant-plan.js";

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
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [
        step({
          stepId: "question",
          kind: "ASK_CLARIFICATION",
          tool: "ASK_CLARIFICATION",
          input: { question: "מה הסכום?" }
        }),
        step({
          stepId: "visit",
          tool: "CREATE_VISIT",
          input: {
            customerId: "customer-1",
            title: "ביקור",
            description: "",
            scheduledStart: "2026-09-02T10:00:00+03:00",
            scheduledEnd: "2026-09-02T11:00:00+03:00"
          }
        }),
        step({
          stepId: "amount",
          tool: "SET_ACTIVITY_AMOUNT",
          input: { entityId: "visit-1", amount: 500, paidAmount: "200" }
        })
      ]
    },
    {},
    "צור ביקור"
  );

  assert.equal(plan.steps[0]!.kind, "CLARIFY");
  assert.equal(plan.steps[1]!.input.startsAt, "2026-09-02T10:00:00+03:00");
  assert.equal(plan.steps[1]!.input.endsAt, "2026-09-02T11:00:00+03:00");
  assert.equal(plan.steps[1]!.input.description, undefined);
  assert.equal(plan.steps[2]!.input.totalAmount, 500);
  assert.equal(plan.steps[2]!.input.paidAmount, 200);
  assert.equal(plan.steps[2]!.input.amount, undefined);
});

test("explicit customer creation removes an unnecessary lookup and retargets dependents", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [
        step({ stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", input: { name: "נועה כהן" } }),
        step({ stepId: "create", tool: "CREATE_CUSTOMER", dependsOn: ["find"], input: { name: "נועה כהן" } }),
        step({
          stepId: "phone",
          tool: "ADD_CUSTOMER_PHONE",
          dependsOn: ["find"],
          input: { customerRef: { stepId: "find", outputField: "entityId" }, phone: "0501234567" }
        })
      ]
    },
    {},
    "תיצור לי לקוח חדש בשם נועה כהן ותוסיף טלפון"
  );

  assert.deepEqual(
    plan.steps.map((item) => item.stepId),
    ["create", "phone"]
  );
  assert.deepEqual(plan.steps[0]!.dependsOn, []);
  assert.deepEqual(plan.steps[1]!.dependsOn, ["create"]);
  assert.deepEqual(plan.steps[1]!.input.customerRef, { stepId: "create", outputField: "entityId" });
});

test("normalizes the LLM search alias used by customer lookup", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [step({ stepId: "find", kind: "READ", tool: "FIND_CUSTOMERS", input: { search: "מאיה לוי" } })]
    },
    {},
    "מצא את מאיה לוי"
  );
  assert.equal(plan.steps[0]!.input.query, "מאיה לוי");
  assert.equal(plan.steps[0]!.input.search, undefined);
});

test("explicit speech confirmation continues the sole pending action with its signed override", () => {
  const plan = normalizeAssistantPlan(
    { ...basePlan, steps: [step({})] },
    {
      pendingActions: [
        {
          id: "pending-1",
          actionType: "CREATE_VISIT",
          requiresExplicitConfirmation: true,
          payload: {
            tool: "CREATE_VISIT",
            input: {
              customerId: "customer-1",
              title: "בדיקה",
              startsAt: "2026-09-02T14:30:00+03:00",
              endsAt: "2026-09-02T15:00:00+03:00"
            },
            confirmationOverrides: { scheduleConflictToken: "signed-token" }
          }
        }
      ]
    },
    "כן, תאשר לקבוע בכל זאת במועד שביקשתי"
  );

  assert.equal(plan.extractedFacts.resolvesPendingActionId, "pending-1");
  assert.equal(plan.steps[0]!.tool, "CREATE_VISIT");
  assert.equal(plan.steps[0]!.input.scheduleConflictToken, "signed-token");
  assert.equal(plan.steps[0]!.requiresExplicitConfirmation, false);
});

test("explicit speech confirmation is available before calling the LLM", () => {
  const plan = deterministicPendingAssistantPlan(
    {
      pendingActions: [
        {
          id: "pending-1",
          actionType: "CREATE_VISIT",
          requiresExplicitConfirmation: true,
          payload: {
            tool: "CREATE_VISIT",
            input: { customerId: "customer-1", title: "בדיקה", startsAt: "2026-09-02T14:30:00+03:00" },
            confirmationOverrides: { scheduleConflictToken: "signed-token" }
          }
        }
      ]
    },
    "כן, תאשר"
  );

  assert.equal(plan?.extractedFacts.resolvesPendingActionId, "pending-1");
  assert.equal(plan?.steps[0]?.input.scheduleConflictToken, "signed-token");
});

test("no-charge completion continues deterministically without another OpenAI call", () => {
  const plan = deterministicPendingAssistantPlan(
    {
      pendingActions: [
        {
          id: "pending-completion",
          actionType: "REPORT_JOB_COMPLETED",
          missingFields: ["noChargeOrAmount"],
          payload: { tool: "REPORT_JOB_COMPLETED", input: { entityId: "job-1" } }
        }
      ]
    },
    "לא היה חיוב"
  );

  assert.equal(plan?.extractedFacts.resolvesPendingActionId, "pending-completion");
  assert.equal(plan?.steps[0]?.tool, "REPORT_JOB_COMPLETED");
  assert.deepEqual(plan?.steps[0]?.input, { entityId: "job-1", noCharge: true });
});

test("a spoken yes creates a missing customer and continues the blocked task", () => {
  const plan = normalizeAssistantPlan(
    { ...basePlan, steps: [step({})] },
    {
      pendingActions: [
        {
          id: "pending-customer",
          actionType: "FIND_CUSTOMERS",
          payload: {
            createCustomerSuggestion: { name: "ג׳ק", sourceStepId: "find_customer" },
            continuationSteps: [
              {
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
              }
            ]
          }
        }
      ]
    },
    "כן"
  );

  assert.equal(plan.extractedFacts.resolvesPendingActionId, "pending-customer");
  assert.deepEqual(
    plan.steps.map((item) => item.tool),
    ["CREATE_CUSTOMER", "CREATE_TASK"]
  );
  assert.deepEqual(plan.steps[1]!.input.customerRef, {
    stepId: "create_missing_customer",
    outputField: "entityId"
  });
});

test("a spoken no rejects the missing customer suggestion", () => {
  const plan = normalizeAssistantPlan(
    { ...basePlan, steps: [step({})] },
    {
      pendingActions: [
        {
          id: "pending-customer",
          actionType: "FIND_CUSTOMERS",
          payload: {
            createCustomerSuggestion: { name: "ג׳ק", sourceStepId: "find_customer" }
          }
        }
      ]
    },
    "לא תודה"
  );

  assert.equal(plan.extractedFacts.rejectsPendingActionId, "pending-customer");
  assert.equal(plan.steps[0]!.tool, "RESPOND");
  assert.match(String(plan.steps[0]!.input.text), /לא יצרתי לקוח בשם ג׳ק/);
});

test("unused nullable fields from strict output are removed before contract validation", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      extractedFacts: { resolvesPendingActionId: null, rejectsPendingActionId: null },
      steps: [
        step({
          tool: "CREATE_CUSTOMER",
          input: { name: "נועה", email: null, generalNotes: null }
        })
      ]
    },
    {},
    "תוסיף לקוחה חדשה בשם נועה"
  );

  assert.deepEqual(plan.steps[0]!.input, { name: "נועה" });
});

test("turns an explicit customer note request into a note work item", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [
        step({
          tool: "UPDATE_CUSTOMER",
          input: { customerId: "customer-1", generalNotes: "הכלב בחצר" }
        })
      ]
    },
    {},
    "תוסיף הערה ללקוח שהכלב בחצר"
  );

  assert.equal(plan.steps[0]!.tool, "CREATE_NOTE");
  assert.equal(plan.steps[0]!.input.customerId, "customer-1");
  assert.equal(plan.steps[0]!.input.text, "הכלב בחצר");
});

test("removes generated activity boilerplate descriptions", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [
        step({
          tool: "CREATE_JOB",
          input: { customerId: "customer-1", title: "התקנת מזגן", description: "עבודה שנקבעה ע״י המשתמש..." }
        })
      ]
    },
    {},
    "תוסיף עבודה להתקנת מזגן"
  );

  assert.equal(plan.steps[0]!.input.description, undefined);
});

test("does not detach a task when nullable structured output was not requested", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [
        step({ tool: "UPDATE_TASK", input: { taskId: "task-1", dueAt: "2026-09-03T08:00:00Z", customerId: null } })
      ]
    },
    {},
    "תדחי את המשימה למחר בשעה אחת עשרה"
  );
  assert.equal(plan.steps[0]!.input.customerId, undefined);
});

test("explicitly missing customer turns a standalone call task into a lookup continuation", () => {
  const plan = normalizeAssistantPlan(
    {
      ...basePlan,
      steps: [step({ tool: "CREATE_TASK", input: { title: "להתקשר לרוני", dueAt: "2026-09-03T07:00:00Z" } })]
    },
    {},
    "תזכירי לי להתקשר לרוני לקוח לא קיים מחר בשעה עשר"
  );
  assert.deepEqual(
    plan.steps.map((item) => item.tool),
    ["FIND_CUSTOMERS", "CREATE_TASK"]
  );
  assert.equal(plan.steps[0]!.input.query, "רוני");
  assert.deepEqual(plan.steps[1]!.input.customerRef, {
    stepId: "find_explicit_missing_customer",
    outputField: "entityId"
  });
});
