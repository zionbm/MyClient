import assert from "node:assert/strict";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { detailsFromHttpException } from "./api-errors.js";

test("preserves domain conflict details without changing the public error envelope", () => {
  const details = detailsFromHttpException(new ConflictException({
    code: "PHONE_ALREADY_ASSIGNED",
    message: "Phone number is already assigned",
    customer: { id: "customer-1", name: "דנה" }
  }));

  assert.deepEqual(details, {
    code: "PHONE_ALREADY_ASSIGNED",
    customer: { id: "customer-1", name: "דנה" }
  });
});

test("keeps explicit details objects intact", () => {
  const details = { code: "SCHEDULE_CONFLICT", conflicts: [] };
  assert.deepEqual(detailsFromHttpException(new ConflictException({ message: "Conflict", details })), details);
});
