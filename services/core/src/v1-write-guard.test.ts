import assert from "node:assert/strict";
import test from "node:test";
import { v1WriteBusinessId } from "./v1-write-guard.js";

test("V1 business mutations are routed through the read-only cutover guard", () => {
  assert.equal(v1WriteBusinessId("POST", "/businesses/business-1/reminders"), "business-1");
  assert.equal(v1WriteBusinessId("PATCH", "/businesses/business%202/customers/customer-1"), "business 2");
  assert.equal(v1WriteBusinessId("DELETE", "/businesses/business-1/quotes/quote-1?confirmed=true"), "business-1");
});

test("reads, V2 routes and internal jobs bypass the V1 write guard", () => {
  assert.equal(v1WriteBusinessId("GET", "/businesses/business-1/reminders"), undefined);
  assert.equal(v1WriteBusinessId("POST", "/v2/businesses/business-1/tasks"), undefined);
  assert.equal(v1WriteBusinessId("POST", "/internal/reminders/due"), undefined);
  assert.equal(v1WriteBusinessId("POST", "/auth/register-business"), undefined);
  assert.equal(v1WriteBusinessId("PATCH", "/businesses/business-1/settings"), undefined);
  assert.equal(v1WriteBusinessId("POST", "/businesses/business-1/customers/customer-1/notes"), undefined);
  assert.equal(v1WriteBusinessId("POST", "/businesses/business-1/voice-commands/realtime-session"), undefined);
});
