import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ActivityStatus } from "@prisma/client";
import { getInternalApiSecret, log } from "@myclient/common";
import {
  AvailabilityQuerySchema,
  ActivityListQuerySchema,
  CreateJobSchema,
  CreateVisitSchema,
  ScheduleQuerySchema,
  ReportCompletedSchema,
  UpdateActivitySchema
} from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreIdempotencyService } from "./core-idempotency.service.js";
import {
  AuditRepository,
  BusinessSettingsRepository,
  ActivitiesRepository,
  CustomersRepository,
  TasksRepository
} from "./core.repositories.js";
import type { ActivityKind, ActivityWrite } from "./repositories/activities.repositories.js";
import { PrismaService } from "./prisma.service.js";
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
} from "./scheduling.js";
import {
  effectiveScheduleEnd,
  issueScheduleConflictToken,
  scheduleConflictFingerprint,
  shiftedScheduleEnd,
  verifyScheduleConflictToken,
  type ScheduleConflictOperation
} from "./schedule-confirmation.js";

type ActivityUpdate = Partial<ActivityWrite> & { version?: number };

@Injectable()
export class CoreActivitiesService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreIdempotencyService) private readonly idempotency: CoreIdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(ActivitiesRepository) private readonly activities: ActivitiesRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  createJob(headers: RequestHeaders, businessId: string, body: unknown) {
    const command = CreateJobSchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.create("job", headers, businessId, command);
  }

  createVisit(headers: RequestHeaders, businessId: string, body: unknown) {
    const command = CreateVisitSchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.create("visit", headers, businessId, command);
  }

  list(kind: ActivityKind, headers: RequestHeaders, businessId: string, query: unknown) {
    return this.listActivities(kind, headers, businessId, query);
  }

  get(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.getActivity(kind, headers, businessId, entityId);
  }

  update(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    const command = UpdateActivitySchema.parse(body);
    if (command.status === "CLOSED") throw new BadRequestException("Use report-completed to close an activity");
    return this.write(
      kind,
      headers,
      businessId,
      entityId,
      "update",
      command,
      {
        customerId: command.customerId,
        title: command.title,
        description: command.description,
        startsAt: parseOptionalDate(command.startsAt),
        endsAt: parseOptionalDate(command.endsAt),
        serviceAddressId: command.serviceAddressId,
        locationSnapshot: command.locationSnapshot,
        status: command.status,
        version: command.version
      },
      command.scheduleConflictToken
    );
  }

  reportCompleted(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string, body: unknown) {
    const command = ReportCompletedSchema.parse(body ?? {});
    return this.lifecycle(kind, headers, businessId, entityId, "report_completed", async (existing, userId) => {
      const amount = existing.amounts[0];
      const paid = amount?.paymentStatus === "PAID";
      return {
        update: {
          executionCompletedAt: new Date(),
          executionCompletedByUserId: userId,
          status:
            paid || (!amount && command.noCharge === true) ? ("CLOSED" as ActivityStatus) : ("OPEN" as ActivityStatus)
        },
        clarification: amount
          ? amount.paymentStatus === "PAID"
            ? undefined
            : "הביצוע הסתיים, אך נשארה יתרה פתוחה ולכן הפעילות נשארה פתוחה."
          : command.noCharge === true
            ? undefined
            : "הביצוע הסתיים. האם היה חיוב עבור הפעילות?"
      };
    });
  }

  cancel(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.lifecycle(kind, headers, businessId, entityId, "cancel", async () => ({
      update: { status: "CANCELLED" }
    }));
  }

  reopen(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    return this.lifecycle(kind, headers, businessId, entityId, "reopen", async () => ({
      update: { status: "OPEN", executionCompletedAt: null, executionCompletedByUserId: null }
    }));
  }

  async delete(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.delete.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request: { entityId },
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          if (!(await this.activities.softDelete(kind, businessId, entityId, user.id, tx)))
            throw new NotFoundException(`${kind} not found`);
          await this.recordAudit(kind, businessId, user.id, entityId, "DELETE", { deleted: true }, tx);
          return { deleted: true, id: entityId };
        })
    });
  }

  async schedule(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = ScheduleQuerySchema.parse(query);
    const items = await this.activities.schedule(businessId, new Date(command.from), new Date(command.to));
    return { items };
  }

  async completed(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = ScheduleQuerySchema.parse(query);
    const from = new Date(command.from);
    const to = new Date(command.to);
    const [tasks, activities] = await Promise.all([
      this.tasks.completedBetween(businessId, from, to),
      this.activities.completedBetween(businessId, from, to)
    ]);
    return { tasks, activities };
  }

  async availability(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = AvailabilityQuerySchema.parse(query);
    const businessSettings = await this.settings.getByBusiness(businessId);
    const hours = (businessSettings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours;
    const window = workingWindow(command.date, businessSettings.timezone, hours);
    const busyItems = window ? await this.activities.schedule(businessId, window.startsAt, window.endsAt) : [];
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
    await this.access.requireBusinessAccess(headers, businessId);
    const timeline = await this.customers.timeline(businessId, customerId);
    if (!timeline) throw new NotFoundException("Customer not found");
    return { items: timeline };
  }

  private async create(
    kind: ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    command: ReturnType<typeof CreateJobSchema.parse>
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const key = requiredIdempotencyKey(headers);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.create`,
      key,
      request: command,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const startsAt = parseOptionalDate(command.startsAt) ?? undefined;
          const endsAt = parseOptionalDate(command.endsAt) ?? undefined;
          const approvedConflictFingerprint =
            startsAt && command.scheduleConflictToken
              ? this.approvedConflictFingerprint(command.scheduleConflictToken, {
                  businessId,
                  userId: user.id,
                  operation: "CREATE",
                  kind,
                  entityId: null,
                  startsAt,
                  endsAt
                })
              : undefined;
          const result = await this.activities.create(
            {
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
            },
            tx
          );
          if ("missingLink" in result) throw new NotFoundException("Customer or service address not found");
          if (!("entity" in result)) {
            if (!startsAt) throw new ConflictException({ code: "SCHEDULE_CONFLICT", conflicts: result.conflicts });
            await this.throwConflict(businessId, user.id, "CREATE", null, startsAt, endsAt, kind, result.conflicts);
          }
          const entity = result.entity;
          if (!entity) throw new NotFoundException(`${kind} was not created`);
          await this.recordAudit(kind, businessId, user.id, entity.id, "CREATE", entity, tx);
          return {
            [kind]: await this.activities.findById(kind, businessId, entity.id, tx),
            warnings: await this.scheduleWarnings(businessId, startsAt, endsAt, kind)
          };
        })
    });
  }

  private async listActivities(kind: ActivityKind, headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = ActivityListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(
      await this.activities.list(kind, businessId, {
        ...pagination,
        status: command.status,
        customerId: command.customerId,
        scheduled: command.scheduled,
        executed: command.executed
      }),
      pagination.limit
    );
    return { [`${kind}s`]: page.items, pageInfo: page.pageInfo };
  }

  private async getActivity(kind: ActivityKind, headers: RequestHeaders, businessId: string, entityId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const entity = await this.activities.findById(kind, businessId, entityId);
    if (!entity) throw new NotFoundException(`${kind} not found`);
    return { [kind]: entity };
  }

  private async write(
    kind: ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    entityId: string,
    action: string,
    request: unknown,
    update: ActivityUpdate,
    scheduleConflictToken?: string,
    allowScheduleConflict = false
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.${kind}.${action}.${entityId}`,
      key: requiredIdempotencyKey(headers),
      request,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const existingForSchedule =
            scheduleConflictToken || update.startsAt !== undefined
              ? await this.activities.findById(kind, businessId, entityId, tx)
              : undefined;
          const normalizedUpdate = { ...update };
          if (update.startsAt !== undefined && update.endsAt === undefined) {
            normalizedUpdate.endsAt =
              update.startsAt === null
                ? null
                : shiftedScheduleEnd(kind, existingForSchedule?.startsAt, existingForSchedule?.endsAt, update.startsAt);
          }
          const tokenStartsAt =
            normalizedUpdate.startsAt === undefined ? existingForSchedule?.startsAt : normalizedUpdate.startsAt;
          const tokenEndsAt =
            normalizedUpdate.endsAt === undefined ? existingForSchedule?.endsAt : normalizedUpdate.endsAt;
          const approvedConflictFingerprint =
            scheduleConflictToken && tokenStartsAt
              ? this.approvedConflictFingerprint(scheduleConflictToken, {
                  businessId,
                  userId: user.id,
                  operation: "UPDATE",
                  kind,
                  entityId,
                  startsAt: tokenStartsAt,
                  endsAt: tokenEndsAt
                })
              : undefined;
          const result = await this.activities.update(
            { kind, businessId, entityId, ...normalizedUpdate, allowScheduleConflict, approvedConflictFingerprint },
            tx
          );
          if ("missingLink" in result) throw new NotFoundException("Customer or service address not found");
          if ("notFound" in result)
            throw new ConflictException({
              code: "ENTITY_VERSION_CONFLICT",
              message: `${kind} changed or was not found`
            });
          if ("invalidSchedule" in result) throw new BadRequestException("endsAt must be after startsAt");
          if (!("entity" in result)) {
            const existing = await this.activities.findById(kind, businessId, entityId, tx);
            const conflictStart = normalizedUpdate.startsAt ?? existing?.startsAt;
            if (!conflictStart) throw new ConflictException({ code: "SCHEDULE_CONFLICT", conflicts: result.conflicts });
            await this.throwConflict(
              businessId,
              user.id,
              "UPDATE",
              entityId,
              conflictStart,
              normalizedUpdate.endsAt ?? existing?.endsAt,
              kind,
              result.conflicts
            );
          }
          if (!result.entity) throw new NotFoundException(`${kind} was not updated`);
          await this.recordAudit(kind, businessId, user.id, entityId, action.toUpperCase(), result.entity, tx);
          return {
            [kind]: await this.activities.findById(kind, businessId, entityId, tx),
            warnings: await this.scheduleWarnings(
              businessId,
              result.entity.startsAt ?? undefined,
              result.entity.endsAt ?? undefined,
              kind
            )
          };
        })
    });
  }

  private async lifecycle(
    kind: ActivityKind,
    headers: RequestHeaders,
    businessId: string,
    entityId: string,
    action: string,
    change: (
      existing: NonNullable<Awaited<ReturnType<ActivitiesRepository["findById"]>>>,
      userId: string
    ) => Promise<{ update: ActivityUpdate; clarification?: string }>
  ) {
    await this.access.requireBusinessAccess(headers, businessId);
    const existing = await this.activities.findById(kind, businessId, entityId);
    if (!existing) throw new NotFoundException(`${kind} not found`);
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const next = await change(existing, user.id);
    const result = await this.write(
      kind,
      headers,
      businessId,
      entityId,
      action,
      { entityId },
      next.update,
      undefined,
      true
    );
    return { ...result, clarification: next.clarification };
  }

  private async throwConflict(
    businessId: string,
    userId: string,
    operation: ScheduleConflictOperation,
    entityId: string | null,
    startsAt: Date,
    endsAt: Date | null | undefined,
    kind: ActivityKind,
    conflicts: unknown[]
  ): Promise<never> {
    const preview = await this.conflictPreview(businessId, startsAt, endsAt, kind, conflicts, {
      userId,
      operation,
      entityId
    });
    log("info", "schedule conflict", {
      businessId,
      kind,
      conflictCount: conflicts.length,
      alternativeCount: preview.alternativeSlots.length
    });
    throw new ConflictException({ message: preview.message, details: preview });
  }

  async conflictPreview(
    businessId: string,
    startsAt: Date,
    endsAt: Date | null | undefined,
    kind: ActivityKind,
    conflicts: unknown[],
    confirmation?: { userId: string; operation: ScheduleConflictOperation; entityId: string | null }
  ) {
    const durationMinutes = Math.max(
      15,
      Math.round(
        ((endsAt?.getTime() ?? startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000) - startsAt.getTime()) / 60_000
      )
    );
    const settings = await this.settings.getByBusiness(businessId);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(startsAt);
    const availability = await this.availabilityForConflict(businessId, date, durationMinutes, settings);
    const effectiveEndsAt = effectiveScheduleEnd(kind, startsAt, endsAt);
    const scheduleConflictToken = confirmation
      ? issueScheduleConflictToken(
          {
            businessId,
            userId: confirmation.userId,
            operation: confirmation.operation,
            kind,
            entityId: confirmation.entityId,
            startsAt: startsAt.toISOString(),
            endsAt: effectiveEndsAt.toISOString(),
            conflictFingerprint: scheduleConflictFingerprint(conflicts)
          },
          getInternalApiSecret()
        )
      : undefined;
    return {
      code: "SCHEDULE_CONFLICT",
      message: "The requested time overlaps another activity",
      kind,
      conflicts,
      alternativeSlots: availability.slice(0, 3),
      scheduleConflictToken
    };
  }

  private approvedConflictFingerprint(
    token: string,
    input: {
      businessId: string;
      userId: string;
      operation: ScheduleConflictOperation;
      kind: ActivityKind;
      entityId: string | null;
      startsAt: Date;
      endsAt?: Date | null;
    }
  ) {
    const claims = verifyScheduleConflictToken(
      token,
      {
        businessId: input.businessId,
        userId: input.userId,
        operation: input.operation,
        kind: input.kind,
        entityId: input.entityId,
        startsAt: input.startsAt.toISOString(),
        endsAt: effectiveScheduleEnd(input.kind, input.startsAt, input.endsAt).toISOString()
      },
      getInternalApiSecret()
    );
    if (!claims)
      log("warn", "schedule confirmation token rejected", {
        businessId: input.businessId,
        kind: input.kind,
        operation: input.operation
      });
    return claims?.conflictFingerprint;
  }

  private async availabilityForConflict(
    businessId: string,
    date: string,
    durationMinutes: number,
    settings: Awaited<ReturnType<BusinessSettingsRepository["getByBusiness"]>>
  ) {
    const window = workingWindow(
      date,
      settings.timezone,
      (settings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours
    );
    if (!window) return [];
    const items = await this.activities.schedule(businessId, window.startsAt, window.endsAt);
    return freeSlots(
      window,
      items.map((item) => ({ startsAt: item.startsAt!, endsAt: item.effectiveEndsAt! })),
      durationMinutes
    );
  }

  async scheduleWarnings(businessId: string, startsAt: Date | undefined, endsAt: Date | undefined, kind: ActivityKind) {
    if (!startsAt) return [];
    const settings = await this.settings.getByBusiness(businessId);
    const effectiveEnd = endsAt ?? new Date(startsAt.getTime() + (kind === "job" ? 120 : 60) * 60_000);
    return isWithinWorkingHours(
      startsAt,
      effectiveEnd,
      settings.timezone,
      (settings.workingHours ?? DEFAULT_WORKING_HOURS) as WorkingHours
    )
      ? []
      : ["הפעילות נקבעה מחוץ לשעות העבודה."];
  }

  private recordAudit(
    kind: ActivityKind,
    businessId: string,
    actorId: string,
    entityId: string,
    action: string,
    after: unknown,
    tx: Prisma.TransactionClient
  ) {
    return this.audit.record(
      {
        businessId,
        actorType: "user",
        actorId,
        source: "core_v2",
        entityType: kind,
        entityId,
        action: `${action}__${kind.toUpperCase()}`,
        after: after as Prisma.InputJsonValue
      },
      tx
    );
  }
}
