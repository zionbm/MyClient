import assert from "node:assert/strict";
import test from "node:test";
import { executeWithDurablePending, idempotencyReplayDecision } from "./v2-idempotency.js";

const now = new Date("2026-09-01T12:00:00.000Z");

test("completed idempotency records replay only for the same payload", () => {
  assert.equal(idempotencyReplayDecision({
    requestHash: "same",
    expectedHash: "same",
    status: "COMPLETED",
    response: { ok: true },
    expiresAt: new Date("2026-08-31T12:00:00.000Z"),
    now
  }), "REPLAY");
  assert.equal(idempotencyReplayDecision({
    requestHash: "different",
    expectedHash: "same",
    status: "COMPLETED",
    response: { ok: true },
    expiresAt: new Date("2026-09-02T12:00:00.000Z"),
    now
  }), "PAYLOAD_MISMATCH");
});

test("pending requests are never reclaimed automatically", () => {
  assert.equal(idempotencyReplayDecision({
    requestHash: "same",
    expectedHash: "same",
    status: "PENDING",
    response: null,
    expiresAt: new Date("2026-09-01T12:30:00.000Z"),
    now
  }), "IN_PROGRESS");
  assert.equal(idempotencyReplayDecision({
    requestHash: "same",
    expectedHash: "same",
    status: "PENDING",
    response: null,
    expiresAt: new Date("2026-08-31T12:00:00.000Z"),
    now
  }), "RESULT_UNKNOWN");
});

test("an execution failure preserves the pending safety record", async () => {
  const phases: string[] = [];
  await assert.rejects(executeWithDurablePending({
    execute: async () => { throw new Error("uncertain failure"); },
    persistCompleted: async () => assert.fail("a failed operation must not be marked completed"),
    onUncertain: (phase) => phases.push(phase)
  }), /uncertain failure/);
  assert.deepEqual(phases, ["EXECUTION"]);
});

test("a response persistence failure remains an uncertain pending result", async () => {
  const phases: string[] = [];
  await assert.rejects(executeWithDurablePending({
    execute: async () => ({ customerId: "customer-1" }),
    persistCompleted: async () => { throw new Error("database unavailable"); },
    onUncertain: (phase) => phases.push(phase)
  }), /database unavailable/);
  assert.deepEqual(phases, ["RESULT_PERSISTENCE"]);
});
