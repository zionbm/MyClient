import "reflect-metadata";
import { BadRequestException, Injectable, Inject, Module, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Prisma } from "@prisma/client";
import {
  ApiExceptionFilter,
  configureHttpObservability,
  getPort,
  log,
  stableIdempotencyKey,
  validateServiceEnvironment
} from "@myclient/common";
import { CreateTaskFromCallSchema, CreateCallTranscriptSchema, CreateIncomingCallSchema } from "@myclient/contracts";
import {
  AuditRepository,
  BusinessPhoneNumbersRepository,
  BusinessSettingsRepository,
  CallTranscriptsRepository,
  IncomingCallsRepository,
  NotificationsRepository,
  TasksRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreNotificationsService } from "./core-notifications.service.js";
import {
  CoreApplicationModule,
  CoreInfrastructureModule,
  CorePersistenceModule,
  CoreProductModule
} from "./core.modules.js";
import {
  buildReminderFromCallDescription,
  buildReminderNotificationBody,
  buildReminderReminderBody,
  defaultAiReminderDueAt,
  type RequestHeaders
} from "./core-utils.js";

@Injectable()
export class CoreService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreNotificationsService) private readonly notificationDelivery: CoreNotificationsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CallTranscriptsRepository) private readonly callTranscripts: CallTranscriptsRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository
  ) {}
  async createIncomingCall(headers: RequestHeaders, body: unknown) {
    this.access.requireInternalSecret(headers);
    const command = CreateIncomingCallSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.findActiveByNumber(command.toNumber);
    const businessId = command.businessId ?? phoneNumber?.businessId;
    if (!businessId) {
      throw new NotFoundException("Business phone number not found");
    }

    const selectedDigit =
      command.selectedDigit === "1" || command.selectedDigit === "2" || command.selectedDigit === "3"
        ? command.selectedDigit
        : undefined;
    const callerIdAvailable = Boolean(command.fromNumber);
    const status = selectedDigit === "1" ? "CALLBACK_REQUESTED" : selectedDigit ? "RECORDING_REQUESTED" : "MENU_PLAYED";
    const incomingCall = await this.incomingCalls.createOrUpdate({
      businessId,
      plivoCallId: command.plivoCallId,
      fromNumber: command.fromNumber,
      toNumber: command.toNumber,
      selectedDigit,
      urgent: selectedDigit === "3",
      status
    });
    const settings = await this.settings.getByBusiness(businessId);
    await this.audit.record({
      businessId,
      actorType: "system",
      source: "telephony",
      entityType: "incoming_call",
      entityId: incomingCall.id,
      action: "UPSERT_INCOMING_CALL",
      after: incomingCall as Prisma.InputJsonValue
    });

    if (!callerIdAvailable) {
      return {
        businessId,
        incomingCall,
        mode: "RECORD_MESSAGE",
        reason: "CALLER_ID_MISSING",
        prompt: settings.reminderPrompt ?? "אנא ציין את שמך ואת מספר הטלפון לחזרה אחרי הצליל."
      };
    }

    if (!selectedDigit) {
      return {
        businessId,
        incomingCall,
        mode: "PLAY_MENU",
        prompt: settings.greetingText ?? "לחזרה טלפונית הקש 1, להשארת הודעה הקש 2, ולמקרה דחוף הקש 3."
      };
    }

    if (selectedDigit === "1") {
      return {
        businessId,
        incomingCall,
        mode: "CREATE_REMINDER_WITHOUT_RECORDING",
        nextWebhook: "/plivo/task-request"
      };
    }

    return {
      businessId,
      incomingCall,
      mode: "RECORD_MESSAGE",
      urgent: selectedDigit === "3",
      prompt: selectedDigit === "3" ? settings.urgentPrompt : settings.reminderPrompt,
      maxSeconds: 60,
      finishOnKey: "#"
    };
  }
  async createCallTranscript(headers: RequestHeaders, body: unknown) {
    this.access.requireInternalSecret(headers);
    const command = CreateCallTranscriptSchema.parse(body);
    const incomingCall = await this.incomingCalls.findByPlivoCallId(command.plivoCallId);
    if (!incomingCall) {
      throw new NotFoundException("Incoming call not found");
    }

    const updatedCall = await this.incomingCalls.update({
      plivoCallId: command.plivoCallId,
      status: "RECORDED",
      urgent: command.urgent ?? incomingCall.urgent,
      recordingUrl: command.recordingUrl
    });
    const taskResult = await this.executeTaskFromCall({
      businessId: incomingCall.businessId,
      incomingCallId: incomingCall.id,
      callerPhone: incomingCall.fromNumber ?? undefined,
      transcript: command.transcript,
      recordingUrl: command.recordingUrl,
      priority: command.urgent || incomingCall.urgent ? "URGENT" : "NORMAL",
      sourceCallId: incomingCall.plivoCallId,
      idempotencyKey: stableIdempotencyKey(
        "plivo_recording",
        `${incomingCall.plivoCallId}:${command.urgent || incomingCall.urgent ? "urgent" : "normal"}`
      )
    });
    const transcript = await this.callTranscripts.create({
      businessId: incomingCall.businessId,
      incomingCallId: incomingCall.id,
      transcript: command.transcript,
      taskId: taskResult.task.id,
      provider: command.provider,
      confidence: command.confidence
    });
    await this.audit.record({
      businessId: incomingCall.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "call_transcript",
      entityId: transcript.id,
      action: "CREATE_CALL_TRANSCRIPT",
      after: transcript as Prisma.InputJsonValue
    });

    return {
      incomingCall: updatedCall,
      transcript,
      task: taskResult
    };
  }
  async createTaskFromCall(headers: RequestHeaders, body: unknown) {
    this.access.requireInternalSecret(headers);
    const command = CreateTaskFromCallSchema.parse(body);
    return this.executeTaskFromCall(command);
  }
  async processDueTasks(headers: RequestHeaders, body: unknown) {
    await this.access.requireInternalScheduler(headers);
    const requestedLimit = Number((body as { limit?: unknown })?.limit ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const dueTasks = await this.tasks.claimDue(limit);
    const processedTasks = [];

    log("info", "due reminder poll started", {
      limit,
      dueTaskCount: dueTasks.length
    });

    for (const task of dueTasks) {
      const notification = await this.notifications.create({
        businessId: task.businessId,
        itemType: "task",
        itemId: task.id,
        title: "תזכורת למשימה",
        body: buildReminderReminderBody(task),
        payload: {
          source: "v2_task_reminder",
          taskId: task.id,
          itemType: "task",
          itemId: task.id,
          dueAt: task.dueAt?.toISOString() ?? null
        }
      });
      const notificationDelivery = await this.notificationDelivery.sendNotification(notification);
      await this.audit.record({
        businessId: task.businessId,
        actorType: "system",
        source: "scheduler",
        entityType: "task",
        entityId: task.id,
        action: "SEND__TASK_NOTIFICATION",
        after: task as Prisma.InputJsonValue,
        result: notificationDelivery.status
      });
      processedTasks.push({ task, notification: notificationDelivery.notification, notificationDelivery });
    }

    log("info", "due reminder poll finished", {
      processed: processedTasks.length
    });

    return {
      processed: processedTasks.length,
      tasks: processedTasks
    };
  }
  private async executeTaskFromCall(command: {
    businessId: string;
    incomingCallId?: string;
    callerPhone?: string;
    transcript?: string;
    recordingUrl?: string;
    priority: "NORMAL" | "URGENT";
    sourceCallId: string;
    idempotencyKey: string;
  }) {
    const existing = await this.tasks.findByIdempotencyKey(command.businessId, command.idempotencyKey);
    if (existing) return { duplicate: true, task: existing };
    const urgentPrefix = command.priority === "URGENT" ? "[URGENT] " : "";
    const task = await this.tasks.create({
      businessId: command.businessId,
      title: `${urgentPrefix}לחזור ללקוח`,
      description: buildReminderFromCallDescription(command.callerPhone, command.transcript),
      dueAt: defaultAiReminderDueAt((await this.settings.getByBusiness(command.businessId)).timezone),
      source: "telephony",
      idempotencyKey: command.idempotencyKey
    });
    if (!task) throw new BadRequestException("Could not create  callback task");
    const notification = await this.notifications.create({
      businessId: command.businessId,
      itemType: "task",
      itemId: task.id,
      title: command.priority === "URGENT" ? "הודעת לקוח דחופה" : "בקשת חזרה ללקוח",
      body: buildReminderNotificationBody(command.callerPhone, command.transcript),
      payload: {
        source: "telephony",
        sourceCallId: command.sourceCallId,
        incomingCallId: command.incomingCallId ?? null,
        recordingUrl: command.recordingUrl ?? null,
        priority: command.priority,
        taskId: task.id,
        itemType: "task",
        itemId: task.id
      }
    });
    const notificationDelivery = await this.notificationDelivery.sendNotification(notification);
    await this.audit.record({
      businessId: command.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "task",
      entityId: task.id,
      action: "CREATE_TASK_FROM_CALL",
      after: task as Prisma.InputJsonValue,
      result: notificationDelivery.status
    });
    return { duplicate: false, task, notification: notificationDelivery.notification, notificationDelivery };
  }
}

const {
  CallsController,
  CORE_SERVICE,
  InternalController,
  NotificationsController,
  SystemController,
  CustomersController,
  NotesController,
  AssistantController,
  ActivitiesController,
  SearchController,
  AmountsController,
  ActionBatchesController,
  TasksController
} = await import("./core.controllers.js");

@Module({
  imports: [CorePersistenceModule, CoreInfrastructureModule, CoreProductModule, CoreApplicationModule],
  controllers: [
    SystemController,
    InternalController,
    CallsController,
    CustomersController,
    NotesController,
    AssistantController,
    ActivitiesController,
    SearchController,
    AmountsController,
    ActionBatchesController,
    TasksController,
    NotificationsController
  ],
  providers: [CoreService, { provide: CORE_SERVICE, useExisting: CoreService }]
})
class CoreRootModule {}

async function bootstrap() {
  validateServiceEnvironment("core");
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(CoreRootModule, adapter);
  app.enableShutdownHooks();
  configureHttpObservability(adapter.getInstance(), "core");
  app.useGlobalFilters(new ApiExceptionFilter("core"));
  const port = getPort("CORE_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  log("info", "core service listening", { port });
}

await bootstrap();
