import assert from "node:assert/strict";
import test from "node:test";
import { AssistantPlanSchema } from "@myclient/contracts";
import { composeAssistantSummary } from "./assistant-reply.js";

function plan() {
  return AssistantPlanSchema.parse({
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: {},
    assistantReply: {
      completedLead: "מעולה, סידרתי את זה.",
      partialLead: "התחלתי לטפל בזה, ונשאר רק פרט קטן.",
      needsInputLead: "בשמחה, רק צריך ממך פרט קטן."
    },
    steps: [
      {
        stepId: "task",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: [],
        input: { title: "לחזור לדוד" },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  });
}

test("combines the model's natural lead with verified execution facts", () => {
  const summary = composeAssistantSummary({
    plan: plan(),
    state: "COMPLETED",
    completedCount: 1,
    messages: ["נפתחה המשימה: לחזור לדוד."],
    questions: [],
    warnings: []
  });
  assert.equal(summary, "מעולה, סידרתי את זה. נפתחה המשימה: לחזור לדוד.");
});

test("allows contextual wording only when its words are present in verified facts", () => {
  const contextualPlan = {
    ...plan(),
    assistantReply: { ...plan().assistantReply!, completedLead: "בדקתי את החלונות הפנויים." }
  };
  const summary = composeAssistantSummary({
    plan: contextualPlan,
    state: "COMPLETED",
    completedCount: 1,
    messages: ["החלונות הפנויים הראשונים הם בבוקר."],
    questions: [],
    warnings: []
  });
  assert.equal(summary, "בדקתי את החלונות הפנויים. החלונות הפנויים הראשונים הם בבוקר.");
});

test("includes completed facts and the pending question in a partial result", () => {
  const summary = composeAssistantSummary({
    plan: plan(),
    state: "PARTIALLY_COMPLETED",
    completedCount: 1,
    messages: ["נוצר לקוח בשם דוד."],
    questions: ["באיזו שעה לקבוע את הביקור?"],
    warnings: []
  });
  assert.match(summary, /נוצר לקוח בשם דוד/);
  assert.match(summary, /באיזו שעה לקבוע את הביקור/);
});

test("rejects a lead containing unverified numbers and keeps warnings", () => {
  const unsafePlan = { ...plan(), assistantReply: { ...plan().assistantReply!, completedLead: "קבעתי ל-14:00." } };
  const summary = composeAssistantSummary({
    plan: unsafePlan,
    state: "COMPLETED",
    completedCount: 1,
    messages: ["הביקור נקבע ל-15:00."],
    questions: [],
    warnings: ["קיימת התנגשות ביומן."]
  });
  assert.equal(summary, "סגור — הביקור נקבע ל-15:00. קיימת התנגשות ביומן.");
});
