import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKING_HOURS, freeSlots, localDateTimeToUtc, workingWindow } from "./v2-scheduling.js";

test("default Israeli work week uses the product-defined hours", () => {
  const sunday = workingWindow("2026-09-06", "Asia/Jerusalem", DEFAULT_WORKING_HOURS);
  const friday = workingWindow("2026-09-11", "Asia/Jerusalem", DEFAULT_WORKING_HOURS);
  const saturday = workingWindow("2026-09-12", "Asia/Jerusalem", DEFAULT_WORKING_HOURS);
  assert.equal(sunday?.startsAt.toISOString(), "2026-09-06T05:00:00.000Z");
  assert.equal(sunday?.endsAt.toISOString(), "2026-09-06T15:00:00.000Z");
  assert.equal(friday?.endsAt.toISOString(), "2026-09-11T11:00:00.000Z");
  assert.equal(saturday, null);
});

test("timezone conversion follows daylight-saving changes", () => {
  assert.equal(localDateTimeToUtc("2026-01-04", "08:00", "Asia/Jerusalem").toISOString(), "2026-01-04T06:00:00.000Z");
  assert.equal(localDateTimeToUtc("2026-07-05", "08:00", "Asia/Jerusalem").toISOString(), "2026-07-05T05:00:00.000Z");
});

test("free slots exclude overlaps and use deterministic 30-minute starts", () => {
  const window = {
    startsAt: new Date("2026-09-06T05:00:00.000Z"),
    endsAt: new Date("2026-09-06T08:00:00.000Z")
  };
  const slots = freeSlots(window, [{
    startsAt: new Date("2026-09-06T06:00:00.000Z"),
    endsAt: new Date("2026-09-06T07:00:00.000Z")
  }], 60);
  assert.deepEqual(slots.map((slot) => slot.startsAt.toISOString()), [
    "2026-09-06T05:00:00.000Z",
    "2026-09-06T07:00:00.000Z"
  ]);
});
