import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCustomerName, normalizeIsraeliPhone, normalizeServiceAddress } from "./normalization.js";

test("normalizes Israeli local and international phones to the same value", () => {
  assert.equal(normalizeIsraeliPhone("050-123-4567"), "+972501234567");
  assert.equal(normalizeIsraeliPhone("+972 50 123 4567"), "+972501234567");
  assert.equal(normalizeIsraeliPhone("9720501234567"), "+972501234567");
});

test("rejects phone values that cannot be normalized safely", () => {
  assert.equal(normalizeIsraeliPhone("123"), null);
  assert.equal(normalizeIsraeliPhone("050-ABC-4567"), null);
});

test("normalizes Hebrew names without choosing fuzzy matches", () => {
  assert.equal(normalizeCustomerName("  דָּנִי  לוי  "), "דני לוי");
  assert.equal(normalizeCustomerName("דני-לוי"), "דני לוי");
});

test("normalizes service addresses for comparison", () => {
  assert.equal(normalizeServiceAddress("הרצל 10, תל אביב"), "הרצל 10 תל אביב");
});
