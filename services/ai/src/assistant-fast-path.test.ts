import assert from "node:assert/strict";
import test from "node:test";
import { deterministicAssistantPlan } from "./assistant-fast-path.js";

const context = {
  environment: {
    now: "2026-09-02T11:00:00.000Z",
    timezone: "Asia/Jerusalem"
  }
};

test("today overview is a single deterministic read without clarification", () => {
  const plan = deterministicAssistantPlan("מה נשאר לי פתוח היום?", context);
  assert.equal(plan?.requestKind, "QUESTION");
  assert.equal(plan?.steps.length, 1);
  assert.equal(plan?.steps[0]?.tool, "GET_TODAY_OVERVIEW");
  assert.deepEqual(plan?.steps[0]?.input, { date: "2026-09-02" });
});

test("explicit new customer and job create both entities without a lookup", () => {
  const plan = deterministicAssistantPlan("הוסף לקוח חדש בשם יואב גת ותוסיף לי עבודה אצלו מחר בשעה 14", context);
  assert.deepEqual(
    plan?.steps.map((step) => step.tool),
    ["CREATE_CUSTOMER", "CREATE_JOB"]
  );
  assert.equal(plan?.steps[0]?.input.name, "יואב גת");
  assert.deepEqual(plan?.steps[1]?.input.customerRef, { stepId: "create_customer", outputField: "entityId" });
  assert.equal(plan?.steps[1]?.input.startsAt, "2026-09-03T11:00:00.000Z");
});

test("explicit customer and activity accepts scheduling language and Hebrew hour words", () => {
  const plan = deterministicAssistantPlan(
    "תוסיפי לקוחה חדשה בשם יעל שלו בדיקת קול ותקבעי אצלה עבודה בשם החלפת ברז מחר בשעה שתיים בצהריים",
    context
  );
  assert.deepEqual(
    plan?.steps.map((step) => step.tool),
    ["CREATE_CUSTOMER", "CREATE_JOB"]
  );
  assert.equal(plan?.steps[0]?.input.name, "יעל שלו בדיקת קול");
  assert.equal(plan?.steps[1]?.input.title, "החלפת ברז");
  assert.equal(plan?.steps[1]?.input.startsAt, "2026-09-03T11:00:00.000Z");
});

test("standalone customer creation does not call the OpenAI planner", () => {
  const plan = deterministicAssistantPlan("תוסיף לי לקוח חדש בשם נועה כהן", context);
  assert.equal(plan?.steps[0]?.tool, "CREATE_CUSTOMER");
  assert.deepEqual(plan?.steps[0]?.input, { name: "נועה כהן" });
});

test("standalone task without customer or time does not call the OpenAI planner", () => {
  const plan = deterministicAssistantPlan("תוסיף לי משימה לקנות מסנן", context);
  assert.equal(plan?.steps[0]?.tool, "CREATE_TASK");
  assert.deepEqual(plan?.steps[0]?.input, { title: "לקנות מסנן" });
});

test("task with customer or time continues to the OpenAI planner", () => {
  assert.equal(deterministicAssistantPlan("תוסיף לי משימה להתקשר ללקוח מחר בשעה 10", context), null);
});

test("unrelated requests continue to the OpenAI planner", () => {
  assert.equal(deterministicAssistantPlan("כמה שילמו לי השבוע?", context), null);
});
