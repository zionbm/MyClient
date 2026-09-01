import { Inject, Injectable } from "@nestjs/common";
import { type ActivityStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { createdAtCursorWhere, paginationTake, type PaginationInput } from "./repository.shared.js";

export type V2ActivityKind = "job" | "visit";

export type V2ActivityWrite = {
  businessId: string;
  customerId: string;
  title: string;
  description?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  serviceAddressId?: string | null;
  locationSnapshot?: string | null;
  status?: ActivityStatus;
  executionCompletedAt?: Date | null;
  executionCompletedByUserId?: string | null;
  idempotencyKey?: string;
};

function effectiveEnd(activity: { startsAt: Date | null; endsAt: Date | null }, kind: V2ActivityKind) {
  if (!activity.startsAt) return null;
  return activity.endsAt ?? new Date(activity.startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000);
}

@Injectable()
export class V2ActivitiesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(kind: V2ActivityKind, businessId: string, pagination: PaginationInput) {
    const args = {
      where: { businessId, deletedAt: null, ...createdAtCursorWhere(pagination.cursor) },
      include: { customer: true, serviceAddress: true, amounts: { where: { deletedAt: null }, take: 1 } },
      orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
      take: paginationTake(pagination)
    };
    return kind === "job" ? this.prisma.job.findMany(args) : this.prisma.visit.findMany(args);
  }

  findById(kind: V2ActivityKind, businessId: string, entityId: string) {
    const args = {
      where: { id: entityId, businessId, deletedAt: null },
      include: { customer: true, serviceAddress: true, amounts: { where: { deletedAt: null }, take: 1 } }
    };
    return kind === "job" ? this.prisma.job.findFirst(args) : this.prisma.visit.findFirst(args);
  }

  async create(input: V2ActivityWrite & { kind: V2ActivityKind; allowScheduleConflict: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchedule(tx, input.businessId);
      const linked = await this.validateLinks(tx, input.businessId, input.customerId, input.serviceAddressId);
      if (!linked.valid) return { missingLink: true as const };
      const locationSnapshot = input.locationSnapshot ?? linked.addressText ?? undefined;
      const conflicts = input.startsAt
        ? await this.conflictsInTransaction(tx, input.businessId, input.startsAt, input.endsAt, input.kind)
        : [];
      if (conflicts.length > 0 && !input.allowScheduleConflict) return { conflicts };
      const { kind: _kind, allowScheduleConflict: _allowScheduleConflict, ...activityInput } = input;
      const data = { ...activityInput, locationSnapshot };
      const entity = input.kind === "job"
        ? await tx.job.create({ data })
        : await tx.visit.create({ data });
      return { entity, conflicts };
    });
  }

  async update(input: Partial<V2ActivityWrite> & {
    kind: V2ActivityKind;
    entityId: string;
    businessId: string;
    version?: number;
    allowScheduleConflict: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchedule(tx, input.businessId);
      const existing = input.kind === "job"
        ? await tx.job.findFirst({ where: { id: input.entityId, businessId: input.businessId, deletedAt: null } })
        : await tx.visit.findFirst({ where: { id: input.entityId, businessId: input.businessId, deletedAt: null } });
      if (!existing || (input.version !== undefined && existing.version !== input.version)) return { notFound: true as const };
      const customerId = input.customerId ?? existing.customerId;
      const serviceAddressId = input.serviceAddressId === undefined ? existing.serviceAddressId : input.serviceAddressId;
      const linked = await this.validateLinks(tx, input.businessId, customerId, serviceAddressId);
      if (!linked.valid) return { missingLink: true as const };
      const startsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt;
      const endsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt;
      if (endsAt && (!startsAt || endsAt <= startsAt)) return { invalidSchedule: true as const };
      const conflicts = startsAt
        ? await this.conflictsInTransaction(tx, input.businessId, startsAt, endsAt, input.kind, input.entityId)
        : [];
      if (conflicts.length > 0 && !input.allowScheduleConflict) return { conflicts };
      const data = {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        serviceAddressId: input.serviceAddressId,
        locationSnapshot: input.locationSnapshot ?? (input.serviceAddressId !== undefined ? linked.addressText : undefined),
        status: input.status,
        executionCompletedAt: input.executionCompletedAt,
        executionCompletedByUserId: input.executionCompletedByUserId,
        version: { increment: 1 }
      };
      const entity = input.kind === "job"
        ? await tx.job.update({ where: { id: input.entityId }, data })
        : await tx.visit.update({ where: { id: input.entityId }, data });
      return { entity, conflicts };
    });
  }

  async softDelete(kind: V2ActivityKind, businessId: string, entityId: string, deletedByUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const deletedAt = new Date();
      const data = { deletedAt, deletedByUserId, version: { increment: 1 } };
      const result = kind === "job"
        ? await tx.job.updateMany({ where: { id: entityId, businessId, deletedAt: null }, data })
        : await tx.visit.updateMany({ where: { id: entityId, businessId, deletedAt: null }, data });
      if (result.count !== 1) return false;
      await tx.amount.updateMany({
        where: { businessId, deletedAt: null, ...(kind === "job" ? { jobId: entityId } : { visitId: entityId }) },
        data: { deletedAt, deletedByUserId }
      });
      return true;
    });
  }

  async schedule(businessId: string, from: Date, to: Date) {
    const where = {
      businessId,
      deletedAt: null,
      status: { not: "CANCELLED" as const },
      startsAt: { not: null, lt: to }
    };
    const [jobs, visits] = await Promise.all([
      this.prisma.job.findMany({ where, include: { customer: true }, orderBy: { startsAt: "asc" } }),
      this.prisma.visit.findMany({ where, include: { customer: true }, orderBy: { startsAt: "asc" } })
    ]);
    return [
      ...jobs.filter((item) => effectiveEnd(item, "job")! > from).map((item) => ({ ...item, kind: "job" as const, effectiveEndsAt: effectiveEnd(item, "job") })),
      ...visits.filter((item) => effectiveEnd(item, "visit")! > from).map((item) => ({ ...item, kind: "visit" as const, effectiveEndsAt: effectiveEnd(item, "visit") }))
    ].sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime());
  }

  private lockSchedule(tx: Prisma.TransactionClient, businessId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`v2_schedule:${businessId}`}))`;
  }

  private async validateLinks(tx: Prisma.TransactionClient, businessId: string, customerId: string, serviceAddressId?: string | null) {
    const customer = await tx.customer.findFirst({ where: { id: customerId, businessId, deletedAt: null, mergedIntoCustomerId: null } });
    if (!customer) return { valid: false as const };
    if (!serviceAddressId) return { valid: true as const, addressText: undefined };
    const address = await tx.serviceAddress.findFirst({ where: { id: serviceAddressId, businessId, customerId, deletedAt: null } });
    return address ? { valid: true as const, addressText: address.addressText } : { valid: false as const };
  }

  private async conflictsInTransaction(
    tx: Prisma.TransactionClient,
    businessId: string,
    startsAt: Date,
    endsAt: Date | null | undefined,
    kind: V2ActivityKind,
    excludeEntityId?: string
  ) {
    const proposedEnd = endsAt ?? new Date(startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000);
    const where = {
      businessId,
      deletedAt: null,
      status: { not: "CANCELLED" as const },
      startsAt: { not: null, lt: proposedEnd },
      ...(excludeEntityId ? { id: { not: excludeEntityId } } : {})
    };
    const [jobs, visits] = await Promise.all([
      tx.job.findMany({ where, select: { id: true, title: true, startsAt: true, endsAt: true } }),
      tx.visit.findMany({ where, select: { id: true, title: true, startsAt: true, endsAt: true } })
    ]);
    return [
      ...jobs.filter((item) => effectiveEnd(item, "job")! > startsAt).map((item) => ({ ...item, kind: "job", effectiveEndsAt: effectiveEnd(item, "job") })),
      ...visits.filter((item) => effectiveEnd(item, "visit")! > startsAt).map((item) => ({ ...item, kind: "visit", effectiveEndsAt: effectiveEnd(item, "visit") }))
    ];
  }
}
