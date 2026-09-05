import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type TaskStatus } from "@prisma/client";
import { CreateTaskSchema, TaskListQuerySchema, UpdateTaskSchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreIdempotencyService } from "./core-idempotency.service.js";
import { AuditRepository, TasksRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import {
  paginatedResponse,
  paginationFromParsedQuery,
  parseOptionalDate,
  requiredIdempotencyKey,
  type RequestHeaders
} from "./core-utils.js";

type TaskUpdate = Omit<Parameters<TasksRepository["update"]>[0], "businessId" | "taskId">;

@Injectable()
export class CoreTasksService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreIdempotencyService) private readonly idempotency: CoreIdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async createTask(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateTaskSchema.parse(body);
    const key = requiredIdempotencyKey(headers);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: "v2.task.create",
      key,
      request: command,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const task = await this.tasks.create(
            {
              businessId,
              customerId: command.customerId,
              title: command.title,
              description: command.description,
              dueAt: parseOptionalDate(command.dueAt) ?? undefined,
              completedAt: command.status === "DONE" ? new Date() : undefined,
              status: command.status,
              source: "app_v2",
              idempotencyKey: key
            },
            tx
          );
          if (!task) throw new NotFoundException("Customer not found");
          await this.recordAudit(businessId, user.id, task.id, "CREATE__TASK", task, tx);
          return { task };
        })
    });
  }

  async listTasks(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = TaskListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(
      await this.tasks.list(businessId, {
        ...pagination,
        state: command.state,
        customerId: command.customerId,
        dueBefore: parseOptionalDate(command.dueBefore) ?? undefined,
        includeUndated: command.includeUndated
      }),
      pagination.limit
    );
    return { tasks: page.items, pageInfo: page.pageInfo };
  }

  async getTask(headers: RequestHeaders, businessId: string, taskId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const task = await this.tasks.findById(businessId, taskId);
    if (!task) throw new NotFoundException("Task not found");
    return { task };
  }

  async updateTask(headers: RequestHeaders, businessId: string, taskId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateTaskSchema.parse(body);
    return this.writeTask(headers, businessId, user.id, taskId, "update", command, {
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      dueAt: parseOptionalDate(command.dueAt),
      completedAt: command.status === "DONE" ? new Date() : command.status === "OPEN" ? null : undefined,
      status: command.status,
      version: command.version
    });
  }

  completeTask(headers: RequestHeaders, businessId: string, taskId: string) {
    return this.lifecycle(headers, businessId, taskId, "complete", "DONE");
  }

  cancelTask(headers: RequestHeaders, businessId: string, taskId: string) {
    return this.lifecycle(headers, businessId, taskId, "cancel", "CANCELLED");
  }

  reopenTask(headers: RequestHeaders, businessId: string, taskId: string) {
    return this.lifecycle(headers, businessId, taskId, "reopen", "OPEN");
  }

  async deleteTask(headers: RequestHeaders, businessId: string, taskId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.task.delete.${taskId}`,
      key: requiredIdempotencyKey(headers),
      request: { taskId },
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const task = await this.tasks.softDelete({ businessId, taskId, deletedByUserId: user.id }, tx);
          if (!task) throw new NotFoundException("Task not found");
          await this.recordAudit(businessId, user.id, task.id, "DELETE__TASK", task, tx);
          return { task };
        })
    });
  }

  private async lifecycle(
    headers: RequestHeaders,
    businessId: string,
    taskId: string,
    action: string,
    status: TaskStatus
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    return this.writeTask(
      headers,
      businessId,
      user.id,
      taskId,
      action,
      { taskId },
      {
        status,
        completedAt: status === "DONE" ? new Date() : status === "OPEN" ? null : undefined
      }
    );
  }

  private writeTask(
    headers: RequestHeaders,
    businessId: string,
    userId: string,
    taskId: string,
    action: string,
    request: unknown,
    update: TaskUpdate
  ) {
    return this.idempotency.execute({
      businessId,
      userId,
      scope: `v2.task.${action}.${taskId}`,
      key: requiredIdempotencyKey(headers),
      request,
      execute: () =>
        this.prisma.$transaction(async (tx) => {
          const task = await this.tasks.update({ ...update, businessId, taskId }, tx);
          if (!task) {
            const existing = await tx.task.findFirst({ where: { id: taskId, businessId, deletedAt: null } });
            if (existing && update.version !== undefined) {
              throw new ConflictException({
                code: "ENTITY_VERSION_CONFLICT",
                message: "Task changed since it was loaded"
              });
            }
            throw new NotFoundException("Task or customer not found");
          }
          await this.recordAudit(businessId, userId, task.id, `${action.toUpperCase()}__TASK`, task, tx);
          return { task };
        })
    });
  }

  private recordAudit(
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
        entityType: "task",
        entityId,
        action,
        after: after as Prisma.InputJsonValue
      },
      tx
    );
  }
}
