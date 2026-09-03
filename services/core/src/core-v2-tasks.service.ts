import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type TaskStatus } from "@prisma/client";
import { V2CreateTaskSchema, V2UpdateTaskSchema } from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { AuditRepository, V2TasksRepository } from "./core.repositories.js";
import {
  paginatedResponse,
  paginationFromQuery,
  parseOptionalDate,
  requiredIdempotencyKey,
  type RequestHeaders
} from "./core-utils.js";

type V2TaskUpdate = Omit<
  Parameters<V2TasksRepository["update"]>[0],
  "businessId" | "taskId"
>;

@Injectable()
export class CoreV2TasksService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(V2TasksRepository) private readonly tasks: V2TasksRepository
  ) {}

  async createTask(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateTaskSchema.parse(body);
    const key = requiredIdempotencyKey(headers);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: "v2.task.create",
      key,
      request: command,
      execute: async () => {
        const task = await this.tasks.create({
          businessId,
          customerId: command.customerId,
          title: command.title,
          description: command.description,
          dueAt: parseOptionalDate(command.dueAt) ?? undefined,
          completedAt: command.status === "DONE" ? new Date() : undefined,
          status: command.status,
          source: "app_v2",
          idempotencyKey: key
        });
        if (!task) throw new NotFoundException("Customer not found");
        await this.recordAudit(businessId, user.id, task.id, "CREATE_V2_TASK", task);
        return { task };
      }
    });
  }

  async listTasks(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.tasks.list(businessId, pagination), pagination.limit);
    return { tasks: page.items, pageInfo: page.pageInfo };
  }

  async getTask(headers: RequestHeaders, businessId: string, taskId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const task = await this.tasks.findById(businessId, taskId);
    if (!task) throw new NotFoundException("Task not found");
    return { task };
  }

  async updateTask(headers: RequestHeaders, businessId: string, taskId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdateTaskSchema.parse(body);
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
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.task.delete.${taskId}`,
      key: requiredIdempotencyKey(headers),
      request: { taskId },
      execute: async () => {
        const task = await this.tasks.softDelete({ businessId, taskId, deletedByUserId: user.id });
        if (!task) throw new NotFoundException("Task not found");
        await this.recordAudit(businessId, user.id, task.id, "DELETE_V2_TASK", task);
        return { task };
      }
    });
  }

  private async lifecycle(headers: RequestHeaders, businessId: string, taskId: string, action: string, status: TaskStatus) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.writeTask(headers, businessId, user.id, taskId, action, { taskId }, {
      status,
      completedAt: status === "DONE" ? new Date() : status === "OPEN" ? null : undefined
    });
  }

  private writeTask(
    headers: RequestHeaders,
    businessId: string,
    userId: string,
    taskId: string,
    action: string,
    request: unknown,
    update: V2TaskUpdate
  ) {
    return this.idempotency.execute({
      businessId,
      userId,
      scope: `v2.task.${action}.${taskId}`,
      key: requiredIdempotencyKey(headers),
      request,
      execute: async () => {
        const task = await this.tasks.update({ ...update, businessId, taskId });
        if (!task) {
          const existing = await this.tasks.findById(businessId, taskId);
          if (existing && update.version !== undefined) {
            throw new ConflictException({ code: "ENTITY_VERSION_CONFLICT", message: "Task changed since it was loaded" });
          }
          throw new NotFoundException("Task or customer not found");
        }
        await this.recordAudit(businessId, userId, task.id, `${action.toUpperCase()}_V2_TASK`, task);
        return { task };
      }
    });
  }

  private recordAudit(businessId: string, actorId: string, entityId: string, action: string, after: unknown) {
    return this.audit.record({
      businessId,
      actorType: "user",
      actorId,
      source: "core_v2",
      entityType: "task",
      entityId,
      action,
      after: after as Prisma.InputJsonValue
    });
  }
}
