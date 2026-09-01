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
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(summary)) return false;
  const receiptText = JSON.stringify(receipt);
  const numbers = summary.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const warnings: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "warnings" && Array.isArray(item)) warnings.push(...item.filter((warning): warning is string => typeof warning === "string"));
      else visit(item);
    }
  };
  visit(receipt);
  return numbers.every((number) => receiptText.includes(number.replace(",", ".")) || receiptText.includes(number)) && warnings.every((warning) => summary.includes(warning));
}
