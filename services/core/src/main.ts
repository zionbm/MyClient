import "reflect-metadata";
import { Body, Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { getPort, health, log } from "@myclient/common";
import { AiActionSchema, CreateCallbackTaskSchema, type AiAction } from "@myclient/contracts";

type Task = {
  id: string;
  businessId: string;
  title: string;
  description?: string;
  priority: "NORMAL" | "URGENT";
  status: "OPEN" | "COMPLETED";
  source: string;
  sourceRef?: string;
  createdAt: string;
};

type Notification = {
  id: string;
  businessId: string;
  taskId: string;
  title: string;
  body: string;
  status: "PENDING";
  createdAt: string;
};

type PendingAction = {
  id: string;
  businessId: string;
  action: AiAction;
  createdAt: string;
};

const tasks: Task[] = [];
const notifications: Notification[] = [];
const pendingActions: PendingAction[] = [];
const idempotencyIndex = new Map<string, Task>();

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

@Controller()
class CoreController {
  @Get("health")
  health() {
    return health("core", { database: "mock-in-memory", notifications: "mock-fcm" });
  }

  @Post("internal/tasks/callback")
  createCallbackTask(@Body() body: unknown) {
    const command = CreateCallbackTaskSchema.parse(body);
    const existing = idempotencyIndex.get(command.idempotencyKey);
    if (existing) {
      return { duplicate: true, task: existing };
    }

    const urgentPrefix = command.priority === "URGENT" ? "[URGENT] " : "";
    const task: Task = {
      id: id("task"),
      businessId: command.businessId,
      title: `${urgentPrefix}Call back customer`,
      description: command.transcript ?? "The customer asked you to call them back.",
      priority: command.priority,
      status: "OPEN",
      source: "telephony",
      sourceRef: command.sourceCallId,
      createdAt: new Date().toISOString()
    };

    const notification: Notification = {
      id: id("notification"),
      businessId: command.businessId,
      taskId: task.id,
      title: command.priority === "URGENT" ? "Urgent customer message" : "Customer callback",
      body: command.transcript ?? `Caller ${command.callerPhone ?? "unknown"} asked for a callback.`,
      status: "PENDING",
      createdAt: new Date().toISOString()
    };

    tasks.push(task);
    notifications.push(notification);
    idempotencyIndex.set(command.idempotencyKey, task);
    log("info", "callback task created", { businessId: command.businessId, taskId: task.id });

    return { duplicate: false, task, notification };
  }

  @Post("owner-actions/execute")
  executeOwnerAction(@Body() body: unknown) {
    const request = body as { businessId?: string; action?: unknown };
    if (!request.businessId) {
      throw new Error("businessId is required");
    }

    const action = AiActionSchema.parse(request.action);
    if (action.missingFields.length > 0) {
      const pending: PendingAction = {
        id: id("pending"),
        businessId: request.businessId,
        action,
        createdAt: new Date().toISOString()
      };
      pendingActions.push(pending);
      return { status: "PENDING_MISSING_INFORMATION", pending };
    }

    if (action.type === "CREATE_TASK") {
      const title = typeof action.payload.title === "string" ? action.payload.title : "Owner task";
      const task: Task = {
        id: id("task"),
        businessId: request.businessId,
        title,
        description: typeof action.payload.description === "string" ? action.payload.description : undefined,
        priority: "NORMAL",
        status: "OPEN",
        source: "ai_owner_command",
        sourceRef: action.idempotencyKey,
        createdAt: new Date().toISOString()
      };
      tasks.push(task);
      return { status: "EXECUTED", task };
    }

    return {
      status: action.requiresConfirmation ? "REVIEW_REQUIRED" : "MOCK_ACCEPTED",
      action
    };
  }

  @Get("businesses/:businessId/tasks")
  listTasks(@Param("businessId") businessId: string) {
    return { tasks: tasks.filter((task) => task.businessId === businessId) };
  }

  @Get("businesses/:businessId/notifications")
  listNotifications(@Param("businessId") businessId: string) {
    return { notifications: notifications.filter((item) => item.businessId === businessId) };
  }
}

@Module({
  controllers: [CoreController]
})
class CoreModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(CoreModule, new FastifyAdapter());
  const port = getPort("CORE_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  log("info", "core service listening", { port });
}

await bootstrap();
