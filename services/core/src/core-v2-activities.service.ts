import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ActivityStatus } from "@prisma/client";
import { getInternalApiSecret, log } from "@myclient/common";
import {
  V2AvailabilityQuerySchema,
  V2ActivityListQuerySchema,
  V2CreateJobSchema,
  V2CreateVisitSchema,
  V2ScheduleQuerySchema,
  V2ReportCompletedSchema,
  V2UpdateActivitySchema
} from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import {
  AuditRepository,
  BusinessSettingsRepository,
    V2ActivitiesRepository,
  V2CustomersRepository,
  V2TasksRepository
} from "./core.repositories.js";
import type { V2ActivityKind, V2ActivityWrite } from "./repositories/v2-activities.repositories.js";
import {
  paginatedResponse,
  paginationFromParsedQuery,
  parseOptionalDate,
  requiredIdempotencyKey,
  type RequestHeaders
} from "./core-utils.js";
import {
  DEFAULT_WORKING_HOURS,
  freeSlots,
  isWithinWorkingHours,
  workingWindow,
  type WorkingHours
} from "./v2-scheduling.js";
import { effectiveScheduleEnd, issueScheduleConflictToken, scheduleConflictFingerprint, shiftedScheduleEnd, verifyScheduleConflictToken, type ScheduleConflictOperation } from "./v2-schedule-confirmation.js";

type ActivityUpdate = Partial<V2ActivityWrite> & { version?: number };

@Injectable()
export class CoreV2ActivitiesService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(V2ActivitiesRepository) private readonly activities: V2ActivitiesRepository,
    @Inject(V2CustomersRepository) private readonly customers: V2CustomersRepository,
    @Inject(V2TasksRepository) private readonly tasks: V2TasksRepository
  ) {}

  createJob(headers: RequestHeaders, businessId: string, body: unknown) {
    const command = V2CreateJobSchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.create("job", headers, businessId, command);
  }

  createVisit(headers: RequestHeaders, businessId: string, body: unknown) {
    const command = V2CreateVisitSchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.create("visit", headers, businessId, command);
  }

  list(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, query: unknown) {
    return this.listActivities(kind, headers, businessId, query);
  }

  get(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.getActivity(kind, headers, businessId, entityId);
  }

  update(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    const command = V2UpdateActivitySchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.write(kind, headers, businessId, entityId, "update", command, {
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      startsAt: parseOptionalDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt),
      serviceAddressId: command.serviceAddressId,
      locationSnapshot: command.locationSnapshot,
      status: command.status,
      version: command.version
    }, command.scheduleConflictToken);
  }

  reportCompleted(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    const command = V2ReportCompletedSchema.parse(body ?? {});
    return this.lifecycle(kind, headers, businessId, entityId, "report_completed", async (existing, userId) => {
      const amount = existing.amounts[0];
      const paid = amount?.paymentStatus === "PAID";
      return {
        update: {
          executionCompletedAt: new Date(),
          executionCompletedByUserId: userId,
          status: paid || (!amount && command.noCharge === true) ? "CLOSED" as ActivityStatus : "OPEN" as ActivityStatus
        },
        clarification: amount
          ? amount.paymentStatus === "PAID" ? undefined : "הביצוע הסתיים, אך נשארה יתרה פתוחה ולכן הפעילות נשארה פתוחה."
          : command.noCharge === true ? undefined : "הביצוע הסתיים. האם היה חיוב עבור הפעילות?"
      };
    });
  }

  cancel(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.lifecycle(kind, headers, businessId, entityId, "cancel", async () => ({ update: { status: "CANCELLED" } }));
  }

  reopen(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.lifecycle(kind, headers, businessId, entityId, "reopen", async () => ({
      update: { status: "OPEN", executionCompletedAt: null, executionCompletedByUserId: null }
    }));
  }

  async delete(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.delete.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request: { entityId },
      execute: async () => {
        if (!await this.activities.softDelete(kind, businessId, entityId, user.id)) throw new NotFoundException(`${kind} not found`);
        await this.recordAudit(kind, businessId, user.id, entityId, "DELETE", { deleted: true });
        return { deleted: true, id: entityId };
      }
    });
  }

  async schedule(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2ScheduleQuerySchema.parse(query);
    const items = await this.activities.schedule(businessId, new Date(command.from), new Date(command.to));
    return { items };
  }

  async completed(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2ScheduleQuerySchema.parse(query);
    const from = new Date(command.from);
    const to = new Date(command.to);
    const [tasks, activities] = await Promise.all([
      this.tasks.completedBetween(businessId, from, to),
      this.activities.completedBetween(businessId, from, to)
    ]);
    return { tasks, activities };
  }

  async availability(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2AvailabilityQuerySchema.parse(query);
    const businessSettings = await this.settings.getByBusiness(businessId);
    const hours = (businessSettings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours;
    const window = workingWindow(command.date, businessSettings.timezone, hours);
    const busyItems = window
      ? await this.activities.schedule(businessId, window.startsAt, window.endsAt)
      : [];
    const busy = busyItems
      .filter((item) => item.id !== command.excludeEntityId)
      .map((item) => ({ startsAt: item.startsAt!, endsAt: item.effectiveEndsAt! }));
    return {
      date: command.date,
      timezone: businessSettings.timezone,
      workingWindow: window,
      busy: busyItems.filter((item) => item.id !== command.excludeEntityId),
      freeSlots: freeSlots(window, busy, command.durationMinutes)
    };
  }

  async customerTimeline(headers: RequestHeaders, businessId: string, customerId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const timeline = await this.customers.timeline(businessId, customerId);
    if (!timeline) throw new NotFoundException("Customer not found");
    return { items: timeline };
  }

  private async create(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, command: ReturnType<typeof V2CreateJobSchema.parse>) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const key = requiredIdempotencyKey(headers);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.create`,
      key,
      request: command,
      execute: async () => {
        const startsAt = parseOptionalDate(command.startsAt) ?? undefined;
        const endsAt = parseOptionalDate(command.endsAt) ?? undefined;
        const approvedConflictFingerprint = startsAt && command.scheduleConflictToken
          ? this.approvedConflictFingerprint(command.scheduleConflictToken, { businessId, userId: user.id, operation: "CREATE", kind, entityId: null, startsAt, endsAt })
          : undefined;
        const result = await this.activities.create({
          kind,
          businessId,
          customerId: command.customerId,
          title: command.title,
          description: command.description,
          startsAt,
          endsAt,
          serviceAddressId: command.serviceAddressId,
          locationSnapshot: command.locationSnapshot,
          status: command.status,
          idempotencyKey: key,
          allowScheduleConflict: false,
          approvedConflictFingerprint
        });
        if ("missingLink" in result) throw new NotFoundException("Customer or service address not found");
        if (!("entity" in result)) {
          if (!startsAt) throw new ConflictException({ code: "SCHEDULE_CONFLICT", conflicts: result.conflicts });
          await this.throwConflict(businessId, user.id, "CREATE", null, startsAt, endsAt, kind, result.conflicts);
        }
        const entity = result.entity;
        if (!entity) throw new NotFoundException(`${kind} was not created`);
        await this.recordAudit(kind, businessId, user.id, entity.id, "CREATE", entity);
        return { [kind]: await this.activities.findById(kind, businessId, entity.id), warnings: await this.scheduleWarnings(businessId, startsAt, endsAt, kind) };
      }
    });
  }

  private async listActivities(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2ActivityListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(await this.activities.list(kind, businessId, {
      ...pagination,
      status: command.status,
      customerId: command.customerId,
      scheduled: command.scheduled,
      executed: command.executed
    }), pagination.limit);
    return { [`${kind}s`]: page.items, pageInfo: page.pageInfo };
  }

  private async getActivity(kind: V2ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const entity = await this.activities.findById(kind, businessId, entityId);
    if (!entity) throw new NotFoundException(`${kind} not found`);
    return { [kind]: entity };
  }

  private async write(
    kind: V2ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    entityId: string,
    action: string,
    request: unknown,
    update: ActivityUpdate,
    scheduleConflictToken?: string,
    allowScheduleConflict = false
  ) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.${action}.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request,
      execute: async () => {
        const existingForSchedule = scheduleConflictToken || update.startsAt !== undefined
          ? await this.activities.findById(kind, businessId, entityId)
          : undefined;
        const normalizedUpdate = { ...update };
        if (update.startsAt !== undefined && update.endsAt === undefined) {
          normalizedUpdate.endsAt = update.startsAt === null
            ? null
            : shiftedScheduleEnd(kind, existingForSchedule?.startsAt, existingForSchedule?.endsAt, update.startsAt);
        }
        const tokenStartsAt = normalizedUpdate.startsAt === undefined ? existingForSchedule?.startsAt : normalizedUpdate.startsAt;
        const tokenEndsAt = normalizedUpdate.endsAt === undefined ? existingForSchedule?.endsAt : normalizedUpdate.endsAt;
        const approvedConflictFingerprint = scheduleConflictToken && tokenStartsAt
          ? this.approvedConflictFingerprint(scheduleConflictToken, { businessId, userId: user.id, operation: "UPDATE", kind, entityId, startsAt: tokenStartsAt, endsAt: tokenEndsAt })
          : undefined;
        const result = await this.activities.update({ kind, businessId, entityId, ...normalizedUpdate, allowScheduleConflict, approvedConflictFingerprint });
        if ("missingLink" in result) throw new NotFoundException("Customer or service address not found");
        if ("notFound" in result) throw new ConflictException({ code: "ENTITY_VERSION_CONFLICT", message: `${kind} changed or was not found` });
        if ("invalidSchedule" in result) throw new BadRequestException("endsAt must be after startsAt");
        if (!("entity" in result)) {
          const existing = await this.activities.findById(kind, businessId, entityId);
          const conflictStart = normalizedUpdate.startsAt ?? existing?.startsAt;
          if (!conflictStart) throw new ConflictException({ code: "SCHEDULE_CONFLICT", conflicts: result.conflicts });
          await this.throwConflict(businessId, user.id, "UPDATE", entityId, conflictStart, normalizedUpdate.endsAt ?? existing?.endsAt, kind, result.conflicts);
        }
        if (!result.entity) throw new NotFoundException(`${kind} was not updated`);
        await this.recordAudit(kind, businessId, user.id, entityId, action.toUpperCase(), result.entity);
        return { [kind]: await this.activities.findById(kind, businessId, entityId), warnings: await this.scheduleWarnings(businessId, result.entity.startsAt ?? undefined, result.entity.endsAt ?? undefined, kind) };
      }
    });
  }

  private async lifecycle(
    kind: V2ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    entityId: string,
    action: string,
    change: (existing: NonNullable<Awaited<ReturnType<V2ActivitiesRepository["findById"]>>>, userId: string) => Promise<{ update: ActivityUpdate; clarification?: string }>
  ) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const existing = await this.activities.findById(kind, businessId, entityId);
    if (!existing) throw new NotFoundException(`${kind} not found`);
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const next = await change(existing, user.id);
    const result = await this.write(kind, headers, businessId, entityId, action, { entityId }, next.update, undefined, true);
    return { ...result, clarification: next.clarification };
  }

  private async throwConflict(businessId: string, userId: string, operation: ScheduleConflictOperation, entityId: string | null, startsAt: Date, endsAt: Date | null | undefined, kind: V2ActivityKind, conflicts: unknown[]): Promise<never> {
    const preview = await this.conflictPreview(businessId, startsAt, endsAt, kind, conflicts, { userId, operation, entityId });
    log("info", "v2 schedule conflict", { businessId, kind, conflictCount: conflicts.length, alternativeCount: preview.alternativeSlots.length });
    throw new ConflictException({ message: preview.message, details: preview });
  }

  async conflictPreview(businessId: string, startsAt: Date, endsAt: Date | null | undefined, kind: V2ActivityKind, conflicts: unknown[], confirmation?: { userId: string; operation: ScheduleConflictOperation; entityId: string | null }) {
    const durationMinutes = Math.max(15, Math.round(((endsAt?.getTime() ?? startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000) - startsAt.getTime()) / 60_000));
    const settings = await this.settings.getByBusiness(businessId);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(startsAt);
    const availability = await this.availabilityForConflict(businessId, date, durationMinutes, settings);
    const effectiveEndsAt = effectiveScheduleEnd(kind, startsAt, endsAt);
    const scheduleConflictToken = confirmation ? issueScheduleConflictToken({
      businessId,
      userId: confirmation.userId,
      operation: confirmation.operation,
      kind,
      entityId: confirmation.entityId,
      startsAt: startsAt.toISOString(),
      endsAt: effectiveEndsAt.toISOString(),
      conflictFingerprint: scheduleConflictFingerprint(conflicts)
    }, getInternalApiSecret()) : undefined;
    return { code: "SCHEDULE_CONFLICT", message: "The requested time overlaps another activity", kind, conflicts, alternativeSlots: availability.slice(0, 3), scheduleConflictToken };
  }

  private approvedConflictFingerprint(token: string, input: { businessId: string; userId: string; operation: ScheduleConflictOperation; kind: V2ActivityKind; entityId: string | null; startsAt: Date; endsAt?: Date | null }) {
    const claims = verifyScheduleConflictToken(token, {
      businessId: input.businessId,
      userId: input.userId,
      operation: input.operation,
      kind: input.kind,
      entityId: input.entityId,
      startsAt: input.startsAt.toISOString(),
      endsAt: effectiveScheduleEnd(input.kind, input.startsAt, input.endsAt).toISOString()
    }, getInternalApiSecret());
    if (!claims) log("warn", "v2 schedule confirmation token rejected", { businessId: input.businessId, kind: input.kind, operation: input.operation });
    return claims?.conflictFingerprint;
  }

  private async availabilityForConflict(businessId: string, date: string, durationMinutes: number, settings: Awaited<ReturnType<BusinessSettingsRepository["getByBusiness"]>>) {
    const window = workingWindow(date, settings.timezone, (settings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours);
    if (!window) return [];
    const items = await this.activities.schedule(businessId, window.startsAt, window.endsAt);
    return freeSlots(window, items.map((item) => ({ startsAt: item.startsAt!, endsAt: item.effectiveEndsAt! })), durationMinutes);
  }

  async scheduleWarnings(businessId: string, startsAt: Date | undefined, endsAt: Date | undefined, kind: V2ActivityKind) {
    if (!startsAt) return [];
    const settings = await this.settings.getByBusiness(businessId);
    const effectiveEnd = endsAt ?? new Date(startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000);
    return isWithinWorkingHours(startsAt, effectiveEnd, settings.timezone, (settings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours)
      ? []
      : ["הפעילות נקבעה מחוץ לשעות העבודה."];
  }

  private recordAudit(kind: V2ActivityKind, businessId: string, actorId: string, entityId: string, action: string, after: unknown) {
    return this.audit.record({ businessId, actorType: "user", actorId, source: "core_v2", entityType: kind, entityId, action: `${action}_V2_${kind.toUpperCase()}`, after: after as Prisma.InputJsonValue });
  }
}
