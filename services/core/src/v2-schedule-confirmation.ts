import { createHmac, timingSafeEqual } from "node:crypto";

export type ScheduleConflictOperation = "CREATE" | "UPDATE";
export type ScheduleConflictKind = "job" | "visit";

export type ScheduleConflictClaims = {
  version: 1;
  businessId: string;
  userId: string;
  operation: ScheduleConflictOperation;
  kind: ScheduleConflictKind;
  entityId: string | null;
  startsAt: string;
  endsAt: string;
  conflictFingerprint: string[];
  expiresAt: number;
};

export const DEFAULT_ACTIVITY_DURATION_MINUTES: Record<ScheduleConflictKind, number> = {
  job: 120,
  visit: 60
};

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`myclient:v2:schedule-conflict:${payload}`).digest("base64url");
}

export function effectiveScheduleEnd(kind: ScheduleConflictKind, startsAt: Date, endsAt?: Date | null) {
  return endsAt ?? new Date(startsAt.getTime() + DEFAULT_ACTIVITY_DURATION_MINUTES[kind] * 60_000);
}

export function shiftedScheduleEnd(
  kind: ScheduleConflictKind,
  existingStartsAt: Date | null | undefined,
  existingEndsAt: Date | null | undefined,
  nextStartsAt: Date
) {
  const durationMs = existingStartsAt
    ? effectiveScheduleEnd(kind, existingStartsAt, existingEndsAt).getTime() - existingStartsAt.getTime()
    : DEFAULT_ACTIVITY_DURATION_MINUTES[kind] * 60_000;
  return new Date(nextStartsAt.getTime() + durationMs);
}

export function scheduleConflictFingerprint(conflicts: unknown[]) {
  return conflicts.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    return typeof item.id === "string" && (item.kind === "job" || item.kind === "visit") && typeof item.version === "number"
      ? [`${item.kind}:${item.id}:${item.version}`]
      : [];
  }).sort();
}

export function issueScheduleConflictToken(input: Omit<ScheduleConflictClaims, "version" | "expiresAt"> & { now?: Date; ttlMs?: number }, secret: string) {
  const claims: ScheduleConflictClaims = {
    version: 1,
    businessId: input.businessId,
    userId: input.userId,
    operation: input.operation,
    kind: input.kind,
    entityId: input.entityId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    conflictFingerprint: [...input.conflictFingerprint].sort(),
    expiresAt: (input.now ?? new Date()).getTime() + (input.ttlMs ?? 5 * 60_000)
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyScheduleConflictToken(token: string, expected: Omit<ScheduleConflictClaims, "version" | "conflictFingerprint" | "expiresAt">, secret: string, now = new Date()) {
  const [payload, providedSignature, extra] = token.split(".");
  if (!payload || !providedSignature || extra) return undefined;
  const expectedSignature = signature(payload, secret);
  const provided = Buffer.from(providedSignature);
  const calculated = Buffer.from(expectedSignature);
  if (provided.length !== calculated.length || !timingSafeEqual(provided, calculated)) return undefined;
  let claims: ScheduleConflictClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ScheduleConflictClaims;
  } catch {
    return undefined;
  }
  if (claims.version !== 1 || claims.expiresAt <= now.getTime() || !Array.isArray(claims.conflictFingerprint)) return undefined;
  if (claims.businessId !== expected.businessId || claims.userId !== expected.userId || claims.operation !== expected.operation || claims.kind !== expected.kind || claims.entityId !== expected.entityId || claims.startsAt !== expected.startsAt || claims.endsAt !== expected.endsAt) return undefined;
  if (!claims.conflictFingerprint.every((value) => typeof value === "string")) return undefined;
  return claims;
}

export function sameConflictFingerprint(left: string[] | undefined, right: string[]) {
  if (!left || left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}
