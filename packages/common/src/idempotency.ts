import { createHash, randomUUID } from "node:crypto";

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function stableIdempotencyKey(prefix: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}
