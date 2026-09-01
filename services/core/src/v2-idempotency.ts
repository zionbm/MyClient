import type { Prisma } from "@prisma/client";

export type IdempotencyReplayDecision = "PAYLOAD_MISMATCH" | "REPLAY" | "IN_PROGRESS" | "RESULT_UNKNOWN";

export function idempotencyReplayDecision(input: {
  requestHash: string;
  expectedHash: string;
  status: string;
  response: Prisma.JsonValue | null;
  expiresAt: Date;
  now?: Date;
}): IdempotencyReplayDecision {
  if (input.requestHash !== input.expectedHash) return "PAYLOAD_MISMATCH";
  if (input.status === "COMPLETED" && input.response !== null) return "REPLAY";
  if (input.expiresAt > (input.now ?? new Date())) return "IN_PROGRESS";
  return "RESULT_UNKNOWN";
}

export async function executeWithDurablePending<T>(input: {
  execute: () => Promise<T>;
  persistCompleted: (response: T) => Promise<void>;
  onUncertain: (phase: "EXECUTION" | "RESULT_PERSISTENCE") => void;
}) {
  let response: T;
  try {
    response = await input.execute();
  } catch (error) {
    input.onUncertain("EXECUTION");
    throw error;
  }
  try {
    await input.persistCompleted(response);
    return response;
  } catch (error) {
    input.onUncertain("RESULT_PERSISTENCE");
    throw error;
  }
}
