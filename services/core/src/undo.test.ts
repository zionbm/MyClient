import assert from "node:assert/strict";
import test from "node:test";
import { orderMutationsForUndo, undoWindowBlockReason } from "./undo.js";

const now = new Date("2026-09-01T10:00:00.000Z");

test("Undo is limited to a live window and the twenty recent batches", () => {
  const base = {
    batchId: "batch-1",
    recentBatchIds: new Set(["batch-1"]),
    undone: false,
    undoEligibleUntil: new Date("2026-09-02T10:00:00.000Z"),
    mutationCount: 2,
    now
  };
  assert.equal(undoWindowBlockReason(base), undefined);
  assert.match(undoWindowBlockReason({ ...base, recentBatchIds: new Set() })!, /20/);
  assert.match(undoWindowBlockReason({ ...base, undoEligibleUntil: new Date("2026-08-31T10:00:00.000Z") })!, /פג/);
  assert.match(undoWindowBlockReason({ ...base, undone: true })!, /כבר/);
  assert.match(undoWindowBlockReason({ ...base, mutationCount: 0 })!, /אין שינויים/);
});

test("Undo applies mutations in exact reverse execution order", () => {
  const ordered = orderMutationsForUndo([{ sequence: 2 }, { sequence: 1 }, { sequence: 3 }]);
  assert.deepEqual(
    ordered.map((item) => item.sequence),
    [3, 2, 1]
  );
});
