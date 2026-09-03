import assert from "node:assert/strict";
import test from "node:test";
import { validateServiceEnvironment } from "./runtime-config.js";

test("production service configuration fails fast without required values", () => {
  assert.throws(
    () => validateServiceEnvironment("core", { NODE_ENV: "production" }),
    /INTERNAL_API_SECRET/
  );
});

test("service configuration rejects malformed booleans and URLs", () => {
  assert.throws(() => validateServiceEnvironment("worker", { WORKER_TASK_POLL_ENABLED: "yes" }), /Invalid boolean/);
  assert.throws(() => validateServiceEnvironment("worker", { CORE_BASE_URL: "not a url" }), /Invalid URL/);
});

test("valid local service configuration keeps development defaults", () => {
  assert.doesNotThrow(() => validateServiceEnvironment("core", { NODE_ENV: "development" }));
});
