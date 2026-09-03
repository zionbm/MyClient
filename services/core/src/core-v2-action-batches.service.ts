import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { log } from "@myclient/common";
import { V2UndoSchema, V2UpdateUserPreferencesSchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { CoreVoiceInternalClient } from "./core-internal-clients.service.js";
import { ActionBatchesRepository, UserPreferencesRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { headerValue, requiredIdempotencyKey, type RequestHeaders } from "./core-utils.js";
import { orderMutationsForUndo, undoWindowBlockReason } from "./v2-undo.js";

function record(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function date(value: unknown) {
  return typeof value === "string" || value instanceof Date ? new Date(value) : null;
}

function records(value: unknown) {
  return Array.isArray(value) ? value.map((item) => record(item as Prisma.JsonValue)).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function sameDate(left: Date | null | undefined, right: unknown) {
  return (left?.toISOString() ?? null) === (date(right)?.toISOString() ?? null);
}

function undoSummary(mutations: ReadonlyArray<{ entityType: string; operation: string }>) {
  if (mutations.some((mutation) => mutation.operation === "MERGE")) return "ביטלתי את המיזוג ושחזרתי את לקוח המקור ואת כל השיוכים שהועברו.";
  if (mutations.some((mutation) => mutation.operation === "RESTORE")) return "ביטלתי את השחזור והחזרתי את הלקוח ואת התלויות שלו למצב המחוק הקודם.";
  const labels: Record<string, string> = {
    customer: "לקוחות",
    customer_phone: "מספרי טלפון",
    service_address: "כתובות",
    task: "משימות",
    job: "עבודות",
    visit: "ביקורים",
    amount: "סכומים"
  };
  const counts = new Map<string, number>();
  for (const mutation of mutations) counts.set(mutation.entityType, (counts.get(mutation.entityType) ?? 0) + 1);
  const details = [...counts].map(([type, count]) => `${count} ${labels[type] ?? type}`).join(", ");
  return `ביטלתי את הפעולה ושחזרתי ${details}.`;
}

@Injectable()
export class CoreV2ActionBatchesService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(ActionBatchesRepository) private readonly batches: ActionBatchesRepository,
    @Inject(UserPreferencesRepository) private readonly preferences: UserPreferencesRepository,
    @Inject(CoreVoiceInternalClient) private readonly voice: CoreVoiceInternalClient,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async list(headers: RequestHeaders, businessId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    return { actionBatches: await this.batches.listRecent(businessId, 20) };
  }

  async get(headers: RequestHeaders, businessId: string, actionBatchId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const actionBatch = await this.batches.findByBusinessAndId(businessId, actionBatchId);
    if (!actionBatch) throw new NotFoundException("Action batch not found");
    return { actionBatch };
  }

  async undoPreview(headers: RequestHeaders, businessId: string, actionBatchId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const result = await this.preview(businessId, actionBatchId);
    log("info", "v2 undo previewed", { businessId, actionBatchId, eligible: result.eligible, blockerCount: result.blockers.length });
    return result;
  }

  async undo(headers: RequestHeaders, businessId: string, actionBatchId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    V2UndoSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.action-batch.undo.${actionBatchId}`,
      key: requiredIdempotencyKey(headers),
      request: { actionBatchId, confirmed: true },
      execute: async () => {
        const result = await this.prisma.$transaction((tx) => this.undoInTransaction(tx, businessId, actionBatchId, user.id));
        log("info", "v2 undo completed", { businessId, actionBatchId, mutationCount: result.revertedMutations });
        return result;
      }
    });
  }

  async undoInTransaction(tx: Prisma.TransactionClient, businessId: string, actionBatchId: string, userId: string) {
    const preview = await this.preview(businessId, actionBatchId);
    if (!preview.eligible) throw new ConflictException({ code: "UNDO_BLOCKED", message: preview.reason, blockers: preview.blockers });
    const batch = await tx.actionBatch.findFirst({ where: { id: actionBatchId, businessId }, include: { mutations: { orderBy: { sequence: "desc" } } } });
    if (!batch) throw new NotFoundException("Action batch not found");
    for (const mutation of orderMutationsForUndo(batch.mutations)) await this.reverseMutation(tx, mutation, userId);
    const summary = undoSummary(batch.mutations);
    const actionBatch = await tx.actionBatch.update({ where: { id: batch.id }, data: { status: "UNDONE", undoneAt: new Date(), undoneByUserId: userId } });
    return { actionBatch, revertedMutations: batch.mutations.length, summary };
  }

  async speech(headers: RequestHeaders, businessId: string, actionBatchId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const batch = await this.batches.findByBusinessAndId(businessId, actionBatchId);
    if (!batch) throw new NotFoundException("Action batch not found");
    const summary = batch.status === "UNDONE" ? `הפעולה בוטלה. ${batch.finalSummary}` : batch.spokenSummary ?? batch.finalSummary;
    return this.voice.synthesizeAssistantSummary(summary, headerValue(headers, "x-request-id"));
  }

  async getPreferences(headers: RequestHeaders) {
    const user = await this.access.requireAuthenticatedUser(headers);
    return { preferences: await this.preferences.getOrCreate(user.id) };
  }

  async updatePreferences(headers: RequestHeaders, body: unknown) {
    const user = await this.access.requireAuthenticatedUser(headers);
    const command = V2UpdateUserPreferencesSchema.parse(body);
    return { preferences: await this.preferences.updateAssistantResponseMode(user.id, command.assistantResponseMode) };
  }

  async runRetention(headers: RequestHeaders) {
    await this.access.requireInternalScheduler(headers);
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const transcriptCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return this.prisma.$transaction(async (tx) => {
      const [redactedBatchTranscripts, redactedTurnTranscripts] = await Promise.all([
        tx.actionBatch.updateMany({ where: { createdAt: { lt: transcriptCutoff }, approvedTranscript: { not: null } }, data: { approvedTranscript: null } }),
        tx.assistantTurn.updateMany({ where: { createdAt: { lt: transcriptCutoff }, approvedTranscript: { not: null } }, data: { approvedTranscript: null } })
      ]);
      const redactedTranscripts = redactedBatchTranscripts.count + redactedTurnTranscripts.count;
      const [customers, tasks, jobs, visits, phones, addresses, amounts] = await Promise.all([
        tx.customer.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
        tx.task.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
        tx.job.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
        tx.visit.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
        tx.customerPhone.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
        tx.serviceAddress.findMany({ where: { deletedAt: { lt: cutoff }, jobs: { none: {} }, visits: { none: {} } }, select: { id: true } }),
        tx.amount.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } })
      ]);
      const entityIds = [...customers, ...tasks, ...jobs, ...visits, ...phones, ...addresses, ...amounts].map((item) => item.id);
      if (entityIds.length === 0) return { cutoff, transcriptCutoff, redactedTranscripts, redactedMutations: 0, deletedEntities: 0 };
      const affectedBatches = await tx.actionMutation.findMany({ where: { entityId: { in: entityIds } }, select: { actionBatchId: true } });
      const redacted = await tx.actionMutation.updateMany({ where: { entityId: { in: entityIds } }, data: { before: Prisma.JsonNull, after: Prisma.JsonNull } });
      await tx.actionBatch.updateMany({
        where: { id: { in: [...new Set(affectedBatches.map((item) => item.actionBatchId))] } },
        data: { approvedTranscript: null, proposedPlan: Prisma.JsonNull, finalSummary: "פרטי הפעולה הוסרו בהתאם למדיניות השמירה.", spokenSummary: null }
      });
      await tx.auditEvent.updateMany({ where: { entityId: { in: entityIds } }, data: { before: Prisma.JsonNull, after: Prisma.JsonNull } });

      const customerIds = customers.map((item) => item.id);
      const dependentJobs = customerIds.length ? await tx.job.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } }) : [];
      const dependentVisits = customerIds.length ? await tx.visit.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } }) : [];
      const jobIds = [...new Set([...jobs.map((item) => item.id), ...dependentJobs.map((item) => item.id)])];
      const visitIds = [...new Set([...visits.map((item) => item.id), ...dependentVisits.map((item) => item.id)])];
      const dependentAmounts = await tx.amount.findMany({ where: { OR: [{ jobId: { in: jobIds } }, { visitId: { in: visitIds } }] }, select: { id: true } });
      const amountIds = [...new Set([...amounts.map((item) => item.id), ...dependentAmounts.map((item) => item.id)])];
      await tx.amountEvent.deleteMany({ where: { amountId: { in: amountIds } } });
      await tx.amount.deleteMany({ where: { id: { in: amountIds } } });
      await tx.task.deleteMany({ where: { OR: [{ id: { in: tasks.map((item) => item.id) } }, { customerId: { in: customerIds } }] } });
      await tx.job.deleteMany({ where: { id: { in: jobIds } } });
      await tx.visit.deleteMany({ where: { id: { in: visitIds } } });
      await tx.note.deleteMany({ where: { customerId: { in: customerIds } } });
      await tx.customerPhone.deleteMany({ where: { OR: [{ id: { in: phones.map((item) => item.id) } }, { customerId: { in: customerIds } }] } });
      await tx.serviceAddress.deleteMany({ where: { OR: [{ id: { in: addresses.map((item) => item.id) } }, { customerId: { in: customerIds } }] } });
      await tx.customer.deleteMany({ where: { id: { in: customerIds } } });
      return { cutoff, transcriptCutoff, redactedTranscripts, redactedMutations: redacted.count, deletedEntities: entityIds.length };
    });
  }

  private async preview(businessId: string, actionBatchId: string) {
    const recent = await this.prisma.actionBatch.findMany({ where: { businessId, status: { in: ["COMPLETED", "PARTIALLY_COMPLETED", "UNDONE"] }, mutations: { some: {} } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true } });
    const batch = await this.prisma.actionBatch.findFirst({ where: { id: actionBatchId, businessId }, include: { mutations: true } });
    if (!batch) throw new NotFoundException("Action batch not found");
    const blockers: Array<Record<string, unknown>> = [];
    let reason = undoWindowBlockReason({
      batchId: batch.id,
      recentBatchIds: new Set(recent.map((item) => item.id)),
      undone: Boolean(batch.undoneAt) || batch.status === "UNDONE",
      undoEligibleUntil: batch.undoEligibleUntil,
      mutationCount: batch.mutations.length
    });
    if (!reason) {
      const entityIds = [...new Set(batch.mutations.flatMap((mutation) => this.mutationEntityIds(mutation)))];
      const later = await this.prisma.actionMutation.findMany({
        where: { entityId: { in: entityIds }, actionBatch: { businessId, createdAt: { gt: batch.createdAt }, undoneAt: null } },
        include: { actionBatch: { select: { id: true, finalSummary: true, createdAt: true } } }
      });
      blockers.push(...later.map((mutation) => ({ actionBatchId: mutation.actionBatch.id, summary: mutation.actionBatch.finalSummary, createdAt: mutation.actionBatch.createdAt })));
      if (blockers.length > 0) reason = "קיימות פעולות מאוחרות שתלויות בשינוי הזה.";
    }
    if (!reason) {
      for (const mutation of batch.mutations) {
        const after = record(mutation.after);
        if (typeof after?.version !== "number") continue;
        const currentVersion = await this.currentVersion(mutation.entityType, mutation.entityId);
        if (currentVersion !== after.version) blockers.push({ entityType: mutation.entityType, entityId: mutation.entityId, reason: "VERSION_CHANGED" });
        if (mutation.operation === "MERGE") blockers.push(...await this.validateMergeSnapshot(mutation.before));
        if (mutation.operation === "RESTORE") blockers.push(...await this.validateRestoreSnapshot(mutation.before));
        if (mutation.operation === "DELETE_CASCADE") blockers.push(...await this.validateDeleteCascadeSnapshot(mutation.before));
      }
      if (blockers.length > 0) reason = "אחת הישויות השתנתה מאז הפעולה.";
    }
    return { eligible: !reason, reason, blockers, actionBatch: batch, mutationCount: batch.mutations.length };
  }

  private async currentVersion(entityType: string, entityId: string) {
    if (entityType === "customer") return (await this.prisma.customer.findUnique({ where: { id: entityId }, select: { version: true } }))?.version;
    if (entityType === "task") return (await this.prisma.task.findUnique({ where: { id: entityId }, select: { version: true } }))?.version;
    if (entityType === "job") return (await this.prisma.job.findUnique({ where: { id: entityId }, select: { version: true } }))?.version;
    if (entityType === "visit") return (await this.prisma.visit.findUnique({ where: { id: entityId }, select: { version: true } }))?.version;
    if (entityType === "amount") return (await this.prisma.amount.findUnique({ where: { id: entityId }, select: { version: true } }))?.version;
    return undefined;
  }

  private async reverseMutation(tx: Prisma.TransactionClient, mutation: { entityType: string; entityId: string; operation: string; before: Prisma.JsonValue | null; after: Prisma.JsonValue | null }, actorUserId: string) {
    const before = record(mutation.before);
    if (mutation.operation === "CREATE") return this.softDeleteCreated(tx, mutation.entityType, mutation.entityId, actorUserId);
    if (!before) throw new ConflictException("Undo snapshot is missing");
    if (mutation.operation === "MERGE") return this.reverseMerge(tx, before);
    if (mutation.operation === "RESTORE") return this.reverseRestore(tx, before);
    if (mutation.operation === "DELETE_CASCADE") return this.reverseDeleteCascade(tx, mutation.entityType, mutation.entityId, before);
    if (mutation.entityType === "customer") return tx.customer.update({ where: { id: mutation.entityId }, data: { name: String(before.name), email: before.email as string | null, normalizedName: before.normalizedName as string | null, generalNotes: before.generalNotes as string | null, deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null, mergedIntoCustomerId: before.mergedIntoCustomerId as string | null, mergedAt: date(before.mergedAt), mergedByUserId: before.mergedByUserId as string | null, version: { increment: 1 } } });
    if (mutation.entityType === "task") return tx.task.update({ where: { id: mutation.entityId }, data: { customerId: before.customerId as string | null, title: String(before.title), description: before.description as string | null, status: before.status as "OPEN" | "DONE" | "CANCELLED", dueAt: date(before.dueAt), completedAt: date(before.completedAt), reminderSentAt: date(before.reminderSentAt), source: String(before.source), sourceRef: before.sourceRef as string | null, idempotencyKey: before.idempotencyKey as string | null, deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null, version: { increment: 1 } } });
    if (mutation.entityType === "job" || mutation.entityType === "visit") {
      const data = { customerId: String(before.customerId), title: String(before.title), description: before.description as string | null, startsAt: date(before.startsAt), endsAt: date(before.endsAt), serviceAddressId: before.serviceAddressId as string | null, locationSnapshot: before.locationSnapshot as string | null, status: before.status as "OPEN" | "CLOSED" | "CANCELLED", executionCompletedAt: date(before.executionCompletedAt), executionCompletedByUserId: before.executionCompletedByUserId as string | null, idempotencyKey: before.idempotencyKey as string | null, deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null, version: { increment: 1 } };
      return mutation.entityType === "job" ? tx.job.update({ where: { id: mutation.entityId }, data }) : tx.visit.update({ where: { id: mutation.entityId }, data });
    }
    if (mutation.entityType === "amount") {
      const existing = await tx.amount.findUniqueOrThrow({ where: { id: mutation.entityId } });
      const amount = await tx.amount.update({ where: { id: mutation.entityId }, data: { jobId: before.jobId as string | null, visitId: before.visitId as string | null, totalAmount: String(before.totalAmount), paidAmount: String(before.paidAmount), currency: String(before.currency), paymentStatus: before.paymentStatus as "UNPAID" | "PARTIALLY_PAID" | "PAID", deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null, version: { increment: 1 } } });
      await tx.amountEvent.create({ data: { businessId: amount.businessId, amountId: amount.id, actorUserId, eventType: "UNDO", previousTotal: existing.totalAmount, nextTotal: amount.totalAmount, previousPaid: existing.paidAmount, nextPaid: amount.paidAmount, paidDelta: amount.paidAmount.minus(existing.paidAmount), source: "undo_v2" } });
      return amount;
    }
    if (mutation.entityType === "customer_phone") return tx.customerPhone.update({ where: { id: mutation.entityId }, data: { customerId: String(before.customerId), rawPhone: String(before.rawPhone), normalizedPhone: String(before.normalizedPhone), label: before.label as string | null, isPrimary: Boolean(before.isPrimary), deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null } });
    if (mutation.entityType === "service_address") return tx.serviceAddress.update({ where: { id: mutation.entityId }, data: { customerId: String(before.customerId), addressText: String(before.addressText), normalizedAddress: before.normalizedAddress as string | null, label: before.label as string | null, deletedAt: date(before.deletedAt), deletedByUserId: before.deletedByUserId as string | null, deleteActionBatchId: before.deleteActionBatchId as string | null } });
    throw new ConflictException(`Undo is unsupported for ${mutation.entityType}`);
  }

  private softDeleteCreated(tx: Prisma.TransactionClient, entityType: string, entityId: string, actorUserId: string) {
    const data = { deletedAt: new Date(), deletedByUserId: actorUserId };
    if (entityType === "customer") return tx.customer.update({ where: { id: entityId }, data: { ...data, version: { increment: 1 } } });
    if (entityType === "task") return tx.task.update({ where: { id: entityId }, data: { ...data, version: { increment: 1 } } });
    if (entityType === "job") return tx.job.update({ where: { id: entityId }, data: { ...data, version: { increment: 1 } } });
    if (entityType === "visit") return tx.visit.update({ where: { id: entityId }, data: { ...data, version: { increment: 1 } } });
    if (entityType === "amount") return tx.amount.update({ where: { id: entityId }, data: { ...data, version: { increment: 1 } } });
    if (entityType === "customer_phone") return tx.customerPhone.update({ where: { id: entityId }, data: { ...data, isPrimary: false } });
    if (entityType === "service_address") return tx.serviceAddress.update({ where: { id: entityId }, data });
    throw new ConflictException(`Undo is unsupported for ${entityType}`);
  }

  private mutationEntityIds(mutation: { entityId: string; operation: string; before: Prisma.JsonValue | null }) {
    if (mutation.operation === "DELETE_CASCADE") {
      const snapshot = record(record(mutation.before)?.deleteCascade as Prisma.JsonValue);
      return [
        mutation.entityId,
        ...records(snapshot?.amounts).flatMap((item) => typeof item.id === "string" ? [item.id] : [])
      ];
    }
    if (mutation.operation === "RESTORE") {
      const snapshot = record(record(mutation.before)?.restoreSnapshot as Prisma.JsonValue);
      return [
        mutation.entityId,
        ...["phones", "addresses", "tasks", "jobs", "visits", "amounts"].flatMap((key) => records(snapshot?.[key]).flatMap((item) => typeof item.id === "string" ? [item.id] : []))
      ];
    }
    if (mutation.operation !== "MERGE") return [mutation.entityId];
    const snapshot = record(record(mutation.before)?.mergeSnapshot as Prisma.JsonValue);
    const target = record(snapshot?.target as Prisma.JsonValue);
    return [
      mutation.entityId,
      typeof target?.id === "string" ? target.id : "",
      ...records(snapshot?.phones).flatMap((change) => {
        const before = record(change.before as Prisma.JsonValue);
        return typeof before?.id === "string" ? [before.id] : [];
      }),
      ...records(snapshot?.addresses).flatMap((change) => {
        const before = record(change.before as Prisma.JsonValue);
        return typeof before?.id === "string" ? [before.id] : [];
      }),
      ...["tasks", "jobs", "visits", "notes"].flatMap((key) => records(snapshot?.[key]).flatMap((item) => typeof item.id === "string" ? [item.id] : []))
    ].filter(Boolean);
  }

  private async validateDeleteCascadeSnapshot(value: Prisma.JsonValue | null) {
    const snapshot = record(record(value)?.deleteCascade as Prisma.JsonValue);
    const activity = record(snapshot?.activity as Prisma.JsonValue);
    if (!snapshot || !activity) return [{ reason: "DELETE_CASCADE_SNAPSHOT_MISSING" }];
    const blockers: Array<Record<string, unknown>> = [];
    for (const item of records(snapshot.amounts)) {
      if (typeof item.id !== "string" || typeof item.version !== "number") continue;
      const current = await this.prisma.amount.findUnique({ where: { id: item.id }, select: { version: true, deletedAt: true } });
      if (!current || !current.deletedAt || current.version !== item.version + 1) blockers.push({ entityType: "amount", entityId: item.id, reason: "DELETE_CASCADE_STATE_CHANGED" });
    }
    return blockers;
  }

  private async reverseDeleteCascade(tx: Prisma.TransactionClient, entityType: string, entityId: string, before: Record<string, unknown>) {
    const snapshot = record(before.deleteCascade as Prisma.JsonValue);
    const activity = record(snapshot?.activity as Prisma.JsonValue);
    if (!snapshot || !activity || (entityType !== "job" && entityType !== "visit")) throw new ConflictException("Delete cascade snapshot is missing");
    const activityData = {
      customerId: String(activity.customerId), title: String(activity.title), description: activity.description as string | null,
      startsAt: date(activity.startsAt), endsAt: date(activity.endsAt), serviceAddressId: activity.serviceAddressId as string | null,
      locationSnapshot: activity.locationSnapshot as string | null, status: activity.status as "OPEN" | "CLOSED" | "CANCELLED",
      executionCompletedAt: date(activity.executionCompletedAt), executionCompletedByUserId: activity.executionCompletedByUserId as string | null,
      idempotencyKey: activity.idempotencyKey as string | null, deletedAt: date(activity.deletedAt),
      deletedByUserId: activity.deletedByUserId as string | null, deleteActionBatchId: activity.deleteActionBatchId as string | null,
      version: { increment: 1 }
    };
    for (const amount of records(snapshot.amounts)) {
      if (typeof amount.id !== "string") continue;
      await tx.amount.update({
        where: { id: amount.id },
        data: {
          jobId: amount.jobId as string | null, visitId: amount.visitId as string | null,
          totalAmount: String(amount.totalAmount), paidAmount: String(amount.paidAmount), currency: String(amount.currency),
          paymentStatus: amount.paymentStatus as "UNPAID" | "PARTIALLY_PAID" | "PAID",
          deletedAt: date(amount.deletedAt), deletedByUserId: amount.deletedByUserId as string | null,
          deleteActionBatchId: amount.deleteActionBatchId as string | null, version: { increment: 1 }
        }
      });
    }
    return entityType === "job"
      ? tx.job.update({ where: { id: entityId }, data: activityData })
      : tx.visit.update({ where: { id: entityId }, data: activityData });
  }

  private async validateMergeSnapshot(value: Prisma.JsonValue | null) {
    const blockers: Array<Record<string, unknown>> = [];
    const snapshot = record(record(value)?.mergeSnapshot as Prisma.JsonValue);
    const target = record(snapshot?.target as Prisma.JsonValue);
    if (!snapshot || !target || typeof target.id !== "string") return [{ reason: "MERGE_SNAPSHOT_MISSING" }];
    const currentTarget = await this.prisma.customer.findUnique({ where: { id: target.id }, select: { version: true } });
    if (currentTarget?.version !== snapshot.targetAfterVersion) blockers.push({ entityType: "customer", entityId: target.id, reason: "VERSION_CHANGED" });
    for (const change of records(snapshot.phones)) {
      const after = record(change.after as Prisma.JsonValue);
      if (typeof after?.id !== "string") continue;
      const current = await this.prisma.customerPhone.findUnique({ where: { id: after.id } });
      if (!current || current.customerId !== after.customerId || current.isPrimary !== after.isPrimary || !sameDate(current.deletedAt, after.deletedAt)) blockers.push({ entityType: "customer_phone", entityId: after.id, reason: "MERGE_STATE_CHANGED" });
    }
    for (const change of records(snapshot.addresses)) {
      const after = record(change.after as Prisma.JsonValue);
      if (typeof after?.id !== "string") continue;
      const current = await this.prisma.serviceAddress.findUnique({ where: { id: after.id } });
      if (!current || current.customerId !== after.customerId || !sameDate(current.deletedAt, after.deletedAt)) blockers.push({ entityType: "service_address", entityId: after.id, reason: "MERGE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.tasks)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.task.findUnique({ where: { id: item.id }, select: { customerId: true, version: true } });
      if (!current || current.customerId !== target.id || current.version !== item.version) blockers.push({ entityType: "task", entityId: item.id, reason: "MERGE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.jobs)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.job.findUnique({ where: { id: item.id }, select: { customerId: true, version: true } });
      if (!current || current.customerId !== target.id || current.version !== item.version) blockers.push({ entityType: "job", entityId: item.id, reason: "MERGE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.visits)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.visit.findUnique({ where: { id: item.id }, select: { customerId: true, version: true } });
      if (!current || current.customerId !== target.id || current.version !== item.version) blockers.push({ entityType: "visit", entityId: item.id, reason: "MERGE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.notes)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.note.findUnique({ where: { id: item.id }, select: { customerId: true } });
      if (!current || current.customerId !== target.id) blockers.push({ entityType: "note", entityId: item.id, reason: "MERGE_STATE_CHANGED" });
    }
    return blockers;
  }

  private async validateRestoreSnapshot(value: Prisma.JsonValue | null) {
    const blockers: Array<Record<string, unknown>> = [];
    const snapshot = record(record(value)?.restoreSnapshot as Prisma.JsonValue);
    const customer = record(snapshot?.customer as Prisma.JsonValue);
    if (!snapshot || !customer || typeof customer.id !== "string") return [{ reason: "RESTORE_SNAPSHOT_MISSING" }];
    for (const item of records(snapshot.phones)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.customerPhone.findUnique({ where: { id: item.id } });
      if (!current || current.deletedAt || current.deleteActionBatchId) blockers.push({ entityType: "customer_phone", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.addresses)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.serviceAddress.findUnique({ where: { id: item.id } });
      if (!current || current.deletedAt || current.deleteActionBatchId) blockers.push({ entityType: "service_address", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.tasks)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.task.findUnique({ where: { id: item.id }, select: { deletedAt: true, deleteActionBatchId: true, version: true } });
      if (!current || current.deletedAt || current.deleteActionBatchId || current.version !== item.version) blockers.push({ entityType: "task", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.jobs)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.job.findUnique({ where: { id: item.id }, select: { deletedAt: true, deleteActionBatchId: true, version: true } });
      if (!current || current.deletedAt || current.deleteActionBatchId || current.version !== item.version) blockers.push({ entityType: "job", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.visits)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.visit.findUnique({ where: { id: item.id }, select: { deletedAt: true, deleteActionBatchId: true, version: true } });
      if (!current || current.deletedAt || current.deleteActionBatchId || current.version !== item.version) blockers.push({ entityType: "visit", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    for (const item of records(snapshot.amounts)) {
      if (typeof item.id !== "string") continue;
      const current = await this.prisma.amount.findUnique({ where: { id: item.id }, select: { deletedAt: true, deleteActionBatchId: true, version: true } });
      if (!current || current.deletedAt || current.deleteActionBatchId || current.version !== item.version) blockers.push({ entityType: "amount", entityId: item.id, reason: "RESTORE_STATE_CHANGED" });
    }
    return blockers;
  }

  private async reverseMerge(tx: Prisma.TransactionClient, before: Record<string, unknown>) {
    const snapshot = record(before.mergeSnapshot as Prisma.JsonValue);
    const source = record(snapshot?.source as Prisma.JsonValue);
    const target = record(snapshot?.target as Prisma.JsonValue);
    if (!snapshot || !source || !target || typeof source.id !== "string" || typeof target.id !== "string") throw new ConflictException("Merge undo snapshot is missing");
    for (const change of records(snapshot.phones)) {
      const previous = record(change.before as Prisma.JsonValue);
      if (typeof previous?.id !== "string") continue;
      await tx.customerPhone.update({ where: { id: previous.id }, data: { customerId: source.id, isPrimary: Boolean(previous.isPrimary), deletedAt: date(previous.deletedAt), deletedByUserId: previous.deletedByUserId as string | null, deleteActionBatchId: previous.deleteActionBatchId as string | null } });
    }
    for (const change of records(snapshot.addresses)) {
      const previous = record(change.before as Prisma.JsonValue);
      if (typeof previous?.id !== "string") continue;
      await tx.serviceAddress.update({ where: { id: previous.id }, data: { customerId: source.id, deletedAt: date(previous.deletedAt), deletedByUserId: previous.deletedByUserId as string | null, deleteActionBatchId: previous.deleteActionBatchId as string | null } });
    }
    const ids = (key: string) => records(snapshot[key]).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
    await Promise.all([
      tx.task.updateMany({ where: { id: { in: ids("tasks") } }, data: { customerId: source.id } }),
      tx.job.updateMany({ where: { id: { in: ids("jobs") } }, data: { customerId: source.id } }),
      tx.visit.updateMany({ where: { id: { in: ids("visits") } }, data: { customerId: source.id } }),
      tx.note.updateMany({ where: { id: { in: ids("notes") } }, data: { customerId: source.id } })
    ]);
    await tx.customer.update({ where: { id: target.id }, data: { version: { increment: 1 } } });
    return tx.customer.update({ where: { id: source.id }, data: { mergedIntoCustomerId: source.mergedIntoCustomerId as string | null, mergedAt: date(source.mergedAt), mergedByUserId: source.mergedByUserId as string | null, version: { increment: 1 } } });
  }

  private async reverseRestore(tx: Prisma.TransactionClient, before: Record<string, unknown>) {
    const snapshot = record(before.restoreSnapshot as Prisma.JsonValue);
    const customer = record(snapshot?.customer as Prisma.JsonValue);
    if (!snapshot || !customer || typeof customer.id !== "string") throw new ConflictException("Restore undo snapshot is missing");
    for (const item of records(snapshot.phones)) {
      if (typeof item.id !== "string") continue;
      await tx.customerPhone.update({ where: { id: item.id }, data: { isPrimary: Boolean(item.isPrimary), deletedAt: date(item.deletedAt), deletedByUserId: item.deletedByUserId as string | null, deleteActionBatchId: item.deleteActionBatchId as string | null } });
    }
    for (const item of records(snapshot.addresses)) {
      if (typeof item.id !== "string") continue;
      await tx.serviceAddress.update({ where: { id: item.id }, data: { deletedAt: date(item.deletedAt), deletedByUserId: item.deletedByUserId as string | null, deleteActionBatchId: item.deleteActionBatchId as string | null } });
    }
    const restoreDeletion = (item: Record<string, unknown>) => ({ deletedAt: date(item.deletedAt), deletedByUserId: item.deletedByUserId as string | null, deleteActionBatchId: item.deleteActionBatchId as string | null, version: { increment: 1 as const } });
    for (const item of records(snapshot.tasks)) if (typeof item.id === "string") await tx.task.update({ where: { id: item.id }, data: restoreDeletion(item) });
    for (const item of records(snapshot.jobs)) if (typeof item.id === "string") await tx.job.update({ where: { id: item.id }, data: restoreDeletion(item) });
    for (const item of records(snapshot.visits)) if (typeof item.id === "string") await tx.visit.update({ where: { id: item.id }, data: restoreDeletion(item) });
    for (const item of records(snapshot.amounts)) if (typeof item.id === "string") await tx.amount.update({ where: { id: item.id }, data: restoreDeletion(item) });
    return tx.customer.update({ where: { id: customer.id }, data: { deletedAt: date(customer.deletedAt), deletedByUserId: customer.deletedByUserId as string | null, deleteActionBatchId: customer.deleteActionBatchId as string | null, version: { increment: 1 } } });
  }
}
