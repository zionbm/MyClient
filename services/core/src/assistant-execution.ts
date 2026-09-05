import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AssistantPlanStep } from "@myclient/contracts";

export function assistantJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function assistantObjectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function orderAssistantSteps(steps: AssistantPlanStep[]) {
  const remaining = new Map(steps.map((step) => [step.stepId, step]));
  const completed = new Set<string>();
  const result: AssistantPlanStep[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((step) => step.dependsOn.every((id) => completed.has(id)));
    if (ready.length === 0) {
      throw new BadRequestException("Assistant plan contains unresolved dependencies");
    }
    for (const step of ready) {
      result.push(step);
      completed.add(step.stepId);
      remaining.delete(step.stepId);
    }
  }

  return result;
}
