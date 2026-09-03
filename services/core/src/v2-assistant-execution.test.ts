import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantPlanStep } from "@myclient/contracts";
import { orderAssistantSteps } from "./v2-assistant-execution.js";

function step(stepId: string, dependsOn: string[] = []): AssistantPlanStep {
  return {
    stepId,
    kind: "READ",
    tool: "FIND_CUSTOMERS",
    dependsOn,
    input: {},
    confidence: 1,
    requiresExplicitConfirmation: false
  };
}

test("orderAssistantSteps preserves dependency order", () => {
  const ordered = orderAssistantSteps([step("third", ["second"]), step("first"), step("second", ["first"])]);
  assert.deepEqual(
    ordered.map((item) => item.stepId),
    ["first", "second", "third"]
  );
});

test("orderAssistantSteps rejects unresolved dependency chains", () => {
  assert.throws(() => orderAssistantSteps([step("first", ["missing"])]), /unresolved dependencies/);
});
