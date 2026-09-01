import assert from "node:assert/strict";
import test from "node:test";
import { activityStatusAfterAmount, assertAmountInvariant, money, nextPaidAmount, paymentStatus } from "./v2-money.js";

test("payment modes distinguish addition, cumulative total and balance", () => {
  const total = money(1000);
  assert.equal(nextPaidAmount("ADD", money(300), total, 200).toString(), "500");
  assert.equal(nextPaidAmount("SET_PAID_TOTAL", money(300), total, 200).toString(), "200");
  assert.equal(nextPaidAmount("SETTLE_BALANCE", money(300), total).toString(), "1000");
});

test("activity closes only after execution and full payment", () => {
  const completedAt = new Date("2026-09-01T10:00:00Z");
  assert.equal(activityStatusAfterAmount("OPEN", null, "PAID"), "OPEN");
  assert.equal(activityStatusAfterAmount("OPEN", completedAt, "PARTIALLY_PAID"), "OPEN");
  assert.equal(activityStatusAfterAmount("OPEN", completedAt, "PAID"), "CLOSED");
  assert.equal(activityStatusAfterAmount("CANCELLED", completedAt, "PAID"), "CANCELLED");
});

test("payment status follows the exact amount matrix", () => {
  assert.equal(paymentStatus(money(1000), money(0)), "UNPAID");
  assert.equal(paymentStatus(money(1000), money(500)), "PARTIALLY_PAID");
  assert.equal(paymentStatus(money(1000), money(1000)), "PAID");
  assert.throws(() => assertAmountInvariant(money(1000), money(1001)), /INVALID_AMOUNT_INVARIANT/);
});
