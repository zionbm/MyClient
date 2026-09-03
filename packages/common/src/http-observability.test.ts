import assert from "node:assert/strict";
import test from "node:test";
import { safeRequestPath } from "./http-observability.js";

test("HTTP logs omit query strings that can contain customer data", () => {
  assert.equal(safeRequestPath({ url: "/v2/businesses/b1/search?q=0501234567" }), "/v2/businesses/b1/search");
});

test("HTTP logs prefer the route template when Fastify provides one", () => {
  assert.equal(safeRequestPath({
    url: "/v2/businesses/b1/customers/c1",
    routeOptions: { url: "/v2/businesses/:businessId/customers/:customerId" }
  }), "/v2/businesses/:businessId/customers/:customerId");
});
