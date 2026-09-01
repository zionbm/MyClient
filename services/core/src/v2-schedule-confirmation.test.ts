import assert from "node:assert/strict";
import test from "node:test";
import { issueScheduleConflictToken, sameConflictFingerprint, scheduleConflictFingerprint, verifyScheduleConflictToken } from "./v2-schedule-confirmation.js";

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
