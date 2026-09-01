import type { AssistantPlanStep } from "@myclient/contracts";

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

export function summaryIsGrounded(summary: string, receipt: unknown) {
  if (!summary.trim() || summary.length > 500) return false;
  const receiptText = JSON.stringify(receipt);
  const numbers = summary.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return numbers.every((number) => receiptText.includes(number.replace(",", ".")) || receiptText.includes(number));
}
