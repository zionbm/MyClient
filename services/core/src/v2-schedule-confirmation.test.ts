import assert from "node:assert/strict";
import test from "node:test";
import { effectiveScheduleEnd, issueScheduleConflictToken, sameConflictFingerprint, scheduleConflictFingerprint, shiftedScheduleEnd, verifyScheduleConflictToken } from "./v2-schedule-confirmation.js";

const secret = "test-secret";
const now = new Date("2026-09-01T12:00:00.000Z");
const expected = {
  businessId: "business-1",
  userId: "user-1",
  operation: "CREATE" as const,
  kind: "job" as const,
  entityId: null,
  startsAt: "2026-09-02T07:00:00.000Z",
  endsAt: "2026-09-02T09:00:00.000Z"
};

test("schedule confirmation token is bound to user, schedule and conflicts", () => {
  const token = issueScheduleConflictToken({ ...expected, conflictFingerprint: ["job:a:2", "visit:b:4"], now }, secret);
  const claims = verifyScheduleConflictToken(token, expected, secret, new Date("2026-09-01T12:04:59.000Z"));
  assert.deepEqual(claims?.conflictFingerprint, ["job:a:2", "visit:b:4"]);
  assert.equal(verifyScheduleConflictToken(token, { ...expected, userId: "user-2" }, secret, now), undefined);
  assert.equal(verifyScheduleConflictToken(token, { ...expected, startsAt: "2026-09-02T08:00:00.000Z" }, secret, now), undefined);
});

test("schedule confirmation rejects tampering and expiry", () => {
  const token = issueScheduleConflictToken({ ...expected, conflictFingerprint: ["job:a:2"], now }, secret);
  assert.equal(verifyScheduleConflictToken(`${token}x`, expected, secret, now), undefined);
  assert.equal(verifyScheduleConflictToken(token, expected, secret, new Date("2026-09-01T12:05:00.000Z")), undefined);
});

test("a confirmation applies only to the exact conflict fingerprint", () => {
  const conflicts = [
    { id: "b", kind: "visit", version: 4 },
    { id: "a", kind: "job", version: 2 }
  ];
  const fingerprint = scheduleConflictFingerprint(conflicts);
  assert.deepEqual(fingerprint, ["job:a:2", "visit:b:4"]);
  assert.equal(sameConflictFingerprint(fingerprint, ["visit:b:4", "job:a:2"]), true);
  assert.equal(sameConflictFingerprint(fingerprint, ["job:a:3", "visit:b:4"]), false);
  assert.equal(sameConflictFingerprint(fingerprint, [...fingerprint, "job:c:1"]), false);
});

test("activity windows use deterministic defaults when only a start is provided", () => {
  const startsAt = new Date("2026-09-02T07:00:00.000Z");
  assert.equal(effectiveScheduleEnd("job", startsAt).toISOString(), "2026-09-02T09:00:00.000Z");
  assert.equal(effectiveScheduleEnd("visit", startsAt).toISOString(), "2026-09-02T08:00:00.000Z");
  const explicitEnd = new Date("2026-09-02T10:30:00.000Z");
  assert.equal(effectiveScheduleEnd("visit", startsAt, explicitEnd), explicitEnd);
});

test("moving an activity without a new end preserves its existing window duration", () => {
  const existingStart = new Date("2026-09-02T07:00:00.000Z");
  const existingEnd = new Date("2026-09-02T10:00:00.000Z");
  const nextStart = new Date("2026-09-03T11:00:00.000Z");
  assert.equal(
    shiftedScheduleEnd("job", existingStart, existingEnd, nextStart).toISOString(),
    "2026-09-03T14:00:00.000Z"
  );
  assert.equal(
    shiftedScheduleEnd("visit", null, null, nextStart).toISOString(),
    "2026-09-03T12:00:00.000Z"
  );
});
