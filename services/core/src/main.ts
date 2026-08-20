import "reflect-metadata";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Business, Prisma, User } from "@prisma/client";
import { ApiExceptionFilter, getEnv, getPort, health, log } from "@myclient/common";
import {
  AiActionSchema,
  CreateCallbackTaskSchema,
  CreateCustomerNoteSchema,
  CreateCustomerSchema,
  CreateTaskSchema,
  RegisterBusinessSchema,
  UpdateCustomerSchema,
  UpdateTaskSchema
} from "@myclient/contracts";
import {
  AuthRepository,
  BusinessesRepository,
  CustomerNotesRepository,
  CustomersRepository,
  NotificationsRepository,
  PendingActionsRepository,
  TasksRepository
} from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

type AuthenticatedUser = User & {
  business: Business;
};

function formatCaller(callerPhone: string | undefined): string {
  return callerPhone ?? "מספר לא מזוהה";
}

function buildCallbackTaskDescription(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `מתקשר: ${caller}\nהודעה: ${transcript}`;
  }

  return `מתקשר: ${caller}\nהלקוח ביקש שתחזור אליו.`;
}

function buildCallbackNotificationBody(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `${caller}: ${transcript}`;
  }

  return `${caller} ביקש שתחזור אליו.`;
}

function parseOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return parsed;
}

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseMockFirebaseUid(headers: RequestHeaders): string {
  const authorization = headerValue(headers, "authorization");
  const prefix = "Bearer mock:";
  if (!authorization?.startsWith(prefix)) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }

  const firebaseUid = authorization.slice(prefix.length).trim();
  if (!firebaseUid) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }

  return firebaseUid;
}

@Controller()
class CoreController {
  constructor(
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(CustomerNotesRepository) private readonly customerNotes: CustomerNotesRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(PendingActionsRepository) private readonly pendingActions: PendingActionsRepository
  ) {}

  @Get("health")
  health() {
    return health("core", { database: "postgresql-prisma", notifications: "mock-fcm" });
  }

  @Post("auth/register-business")
  async registerBusiness(@Body() body: unknown) {
    const command = RegisterBusinessSchema.parse(body);
    const result = await this.auth.registerBusiness(command);
    return {
      created: result.created,
      business: result.business,
      user: {
        id: result.user.id,
        businessId: result.user.businessId,
        email: result.user.email,
        displayName: result.user.displayName,
        firebaseUid: result.user.firebaseUid,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt
      }
    };
  }

  @Get("auth/me")
  async me(@Headers() headers: RequestHeaders) {
    const user = await this.requireAuthenticatedUser(headers);
    return {
      user: {
        id: user.id,
        businessId: user.businessId,
        email: user.email,
        displayName: user.displayName,
        firebaseUid: user.firebaseUid,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      business: user.business
    };
  }

  @Post("internal/tasks/callback")
  async createCallbackTask(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
    const command = CreateCallbackTaskSchema.parse(body);
    const existing = await this.tasks.findByIdempotencyKey(command.businessId, command.idempotencyKey);
    if (existing) {
      return { duplicate: true, task: existing };
    }

    const urgentPrefix = command.priority === "URGENT" ? "[URGENT] " : "";
    const task = await this.tasks.create({
      businessId: command.businessId,
      title: `${urgentPrefix}לחזור ללקוח`,
      description: buildCallbackTaskDescription(command.callerPhone, command.transcript),
      priority: command.priority,
      source: "telephony",
      sourceRef: command.sourceCallId,
      idempotencyKey: command.idempotencyKey
    });

    const notification = await this.notifications.create({
      businessId: command.businessId,
      taskId: task.id,
      title: command.priority === "URGENT" ? "הודעת לקוח דחופה" : "בקשת חזרה ללקוח",
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
  async executeOwnerAction(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    const request = body as { businessId?: string; action?: unknown };
    if (!request.businessId) {
      throw new BadRequestException("businessId is required");
    }

    const user = await this.requireBusinessAccess(headers, request.businessId);
    const action = AiActionSchema.parse(request.action);
    if (action.missingFields.length > 0) {
      const pending = await this.pendingActions.create({
        businessId: request.businessId,
        userId: user.id,
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
  async listTasks(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { tasks: await this.tasks.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/tasks")
  async createTask(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = CreateTaskSchema.parse(body);
    const task = await this.tasks.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt) ?? undefined,
      source: "app"
    });
    return { task };
  }

  @Patch("businesses/:businessId/tasks/:taskId")
  async updateTask(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("taskId") taskId: string,
    @Body() body: unknown
  ) {
    await this.requireBusinessAccess(headers, businessId);
    const command = UpdateTaskSchema.parse(body);
    const task = await this.tasks.update({
      businessId,
      taskId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt),
      status: command.status
    });

    if (!task) {
      throw new NotFoundException("Task not found");
    }

    return { task };
  }

  @Post("businesses/:businessId/tasks/:taskId/complete")
  async completeTask(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("taskId") taskId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const task = await this.tasks.complete(businessId, taskId);
    if (!task) {
      throw new NotFoundException("Task not found");
    }

    return { task };
  }

  @Post("businesses/:businessId/customers")
  async createCustomer(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = CreateCustomerSchema.parse(body);
    const customer = await this.customers.create({
      businessId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address
    });
    return { customer };
  }

  @Get("businesses/:businessId/customers")
  async listCustomers(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { customers: await this.customers.listByBusiness(businessId) };
  }

  @Get("businesses/:businessId/customers/:customerId")
  async getCustomer(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("customerId") customerId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const customer = await this.customers.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new NotFoundException("Customer not found");
    }

    return { customer };
  }

  @Patch("businesses/:businessId/customers/:customerId")
  async updateCustomer(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown
  ) {
    await this.requireBusinessAccess(headers, businessId);
    const command = UpdateCustomerSchema.parse(body);
    const customer = await this.customers.update({
      businessId,
      customerId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }

    return { customer };
  }

  @Post("businesses/:businessId/customers/:customerId/notes")
  async createCustomerNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown
  ) {
    await this.requireBusinessAccess(headers, businessId);
    const command = CreateCustomerNoteSchema.parse(body);
    const note = await this.customerNotes.create({
      businessId,
      customerId,
      text: command.text
    });

    if (!note) {
      throw new NotFoundException("Customer not found");
    }

    return { note };
  }

  @Get("businesses/:businessId/customers/:customerId/notes")
  async listCustomerNotes(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("customerId") customerId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const notes = await this.customerNotes.listByCustomer(businessId, customerId);
    if (!notes) {
      throw new NotFoundException("Customer not found");
    }

    return { notes };
  }

  @Get("businesses/:businessId/notifications")
  async listNotifications(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { notifications: await this.notifications.listByBusiness(businessId) };
  }

  private async requireAuthenticatedUser(headers: RequestHeaders): Promise<AuthenticatedUser> {
    const firebaseUid = parseMockFirebaseUid(headers);
    const user = await this.auth.getMe(firebaseUid);
    if (!user) {
      throw new UnauthorizedException("Authenticated user was not found");
    }
    return user;
  }

  private async requireBusinessAccess(headers: RequestHeaders, businessId: string): Promise<AuthenticatedUser> {
    const user = await this.requireAuthenticatedUser(headers);
    if (user.businessId !== businessId) {
      throw new ForbiddenException("User is not allowed to access this business");
    }
    return user;
  }

  private requireInternalSecret(headers: RequestHeaders): void {
    const expected = getEnv("INTERNAL_API_SECRET", "dev-internal-secret");
    const actual = headerValue(headers, "x-internal-secret");
    if (actual !== expected) {
      throw new UnauthorizedException("Missing or invalid internal secret");
    }
  }
}

@Module({
  controllers: [CoreController],
  providers: [
    PrismaService,
    AuthRepository,
    BusinessesRepository,
    CustomersRepository,
    TasksRepository,
    CustomerNotesRepository,
    NotificationsRepository,
    PendingActionsRepository
  ]
})
class CoreModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(CoreModule, new FastifyAdapter());
  app.useGlobalFilters(new ApiExceptionFilter("core"));
  const port = getPort("CORE_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  log("info", "core service listening", { port });
}

await bootstrap();
