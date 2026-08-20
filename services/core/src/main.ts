import "reflect-metadata";
import { Body, Controller, Get, Inject, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Prisma } from "@prisma/client";
import { getPort, health, log } from "@myclient/common";
import { AiActionSchema, CreateCallbackTaskSchema } from "@myclient/contracts";
import { BusinessesRepository, NotificationsRepository, PendingActionsRepository, TasksRepository } from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";

function formatCaller(callerPhone: string | undefined): string {
  return callerPhone ?? "unknown caller";
}

function buildCallbackTaskDescription(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `Caller: ${caller}\nMessage: ${transcript}`;
  }

  return `Caller: ${caller}\nThe customer asked you to call them back.`;
}

function buildCallbackNotificationBody(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `${caller}: ${transcript}`;
  }

  return `${caller} asked for a callback.`;
}

@Controller()
class CoreController {
  constructor(
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(PendingActionsRepository) private readonly pendingActions: PendingActionsRepository
  ) {}

  @Get("health")
  health() {
    return health("core", { database: "postgresql-prisma", notifications: "mock-fcm" });
  }

  @Post("internal/tasks/callback")
  async createCallbackTask(@Body() body: unknown) {
    const command = CreateCallbackTaskSchema.parse(body);
    const existing = await this.tasks.findByIdempotencyKey(command.businessId, command.idempotencyKey);
    if (existing) {
      return { duplicate: true, task: existing };
    }

    const urgentPrefix = command.priority === "URGENT" ? "[URGENT] " : "";
    const task = await this.tasks.create({
      businessId: command.businessId,
      title: `${urgentPrefix}Call back customer`,
      description: buildCallbackTaskDescription(command.callerPhone, command.transcript),
      priority: command.priority,
      source: "telephony",
      sourceRef: command.sourceCallId,
      idempotencyKey: command.idempotencyKey
    });

    const notification = await this.notifications.create({
      businessId: command.businessId,
      taskId: task.id,
      title: command.priority === "URGENT" ? "Urgent customer message" : "Customer callback",
      body: buildCallbackNotificationBody(command.callerPhone, command.transcript),
      payload: {
        source: "telephony",
        sourceCallId: command.sourceCallId,
        callerPhone: command.callerPhone ?? null,
        priority: command.priority
      }
    });

    log("info", "callback task created", { businessId: command.businessId, taskId: task.id });

    return { duplicate: false, task, notification };
  }

  @Post("owner-actions/execute")
  async executeOwnerAction(@Body() body: unknown) {
    const request = body as { businessId?: string; action?: unknown };
    if (!request.businessId) {
      throw new Error("businessId is required");
    }

    const action = AiActionSchema.parse(request.action);
    if (action.missingFields.length > 0) {
      const pending = await this.pendingActions.create({
        businessId: request.businessId,
        actionType: action.type,
        payload: action.payload as Prisma.InputJsonValue,
        missingFields: action.missingFields
      });
      return { status: "PENDING_MISSING_INFORMATION", pending };
    }

    if (action.type === "CREATE_TASK") {
      const existing = await this.tasks.findByIdempotencyKey(request.businessId, action.idempotencyKey);
      if (existing) {
        return { status: "EXECUTED", duplicate: true, task: existing };
      }

      const title = typeof action.payload.title === "string" ? action.payload.title : "Owner task";
      const task = await this.tasks.create({
        businessId: request.businessId,
        title,
        description: typeof action.payload.description === "string" ? action.payload.description : undefined,
        priority: "NORMAL",
        source: "ai_owner_command",
        sourceRef: action.idempotencyKey,
        idempotencyKey: action.idempotencyKey
      });
      return { status: "EXECUTED", duplicate: false, task };
    }

    return {
      status: action.requiresConfirmation ? "REVIEW_REQUIRED" : "MOCK_ACCEPTED",
      action
    };
  }

  @Get("businesses/:businessId/tasks")
  async listTasks(@Param("businessId") businessId: string) {
    return { tasks: await this.tasks.listByBusiness(businessId) };
  }

  @Get("businesses/:businessId/notifications")
  async listNotifications(@Param("businessId") businessId: string) {
    return { notifications: await this.notifications.listByBusiness(businessId) };
  }
}

@Module({
  controllers: [CoreController],
  providers: [
    PrismaService,
    BusinessesRepository,
    TasksRepository,
    NotificationsRepository,
    PendingActionsRepository
  ]
})
class CoreModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(CoreModule, new FastifyAdapter());
  const port = getPort("CORE_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  log("info", "core service listening", { port });
}

await bootstrap();
