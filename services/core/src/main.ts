import "reflect-metadata";
import {
  BadRequestException,
  Injectable,
  Inject,
  Module,
  NotFoundException
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Prisma } from "@prisma/client";
import { ApiExceptionFilter, configureHttpObservability, getPort, log, stableIdempotencyKey } from "@myclient/common";
import {
  AiActionSchema,
  CreateReminderFromCallSchema,
  CreateCallTranscriptSchema,
  CreateIncomingCallSchema,
} from "@myclient/contracts";
import {
  AppointmentsRepository,
  AuthRepository,
  AuditRepository,
  BusinessMembersRepository,
  BusinessesRepository,
  BusinessPhoneNumbersRepository,
  BusinessSettingsRepository,
  CallTranscriptsRepository,
  NotesRepository,
  CustomersRepository,
  DeviceTokensRepository,
  HomeVisitsRepository,
  IncomingCallsRepository,
  NotificationsRepository,
  OwnerVoiceCommandsRepository,
  AiPendingActionsRepository,
  ActionBatchesRepository,
  QuotesRepository,
  UserPreferencesRepository,
  RemindersRepository
} from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreNotificationsService } from "./core-notifications.service.js";
import { CoreVoiceGatewayService } from "./core-voice-gateway.service.js";
import { CoreWorkItemPresenter } from "./core-work-item.presenter.js";
import { CoreActionExecutionService } from "./core-action-execution.service.js";
import { CoreVoiceResultPresenter } from "./core-voice-result.presenter.js";
import { CoreCustomersService } from "./core-customers.service.js";
import { CoreWorkItemsService } from "./core-work-items.service.js";
import { CoreSearchService } from "./core-search.service.js";
import { CoreNotificationsApplicationService } from "./core-notifications-application.service.js";
import { CoreAiInternalClient, CoreVoiceInternalClient } from "./core-internal-clients.service.js";
import { CoreAiPendingActionsApplicationService } from "./core-ai-pending-actions-application.service.js";
import { CoreBusinessApplicationService } from "./core-business-application.service.js";
import { CoreOpenAiRealtimeClient } from "./core-openai-realtime-client.service.js";
import { CoreVoiceActionsService } from "./core-voice-actions.service.js";
import { CoreVoiceCommandsApplicationService } from "./core-voice-commands-application.service.js";
import {
  buildReminderFromCallDescription,
  buildReminderNotificationBody,
  buildReminderReminderBody,
  type RequestHeaders
} from "./core-utils.js";

@Injectable()
export class CoreService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreNotificationsService) private readonly notificationDelivery: CoreNotificationsService,
    @Inject(CoreVoiceActionsService) private readonly voiceActions: CoreVoiceActionsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CallTranscriptsRepository) private readonly callTranscripts: CallTranscriptsRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(AiPendingActionsRepository) private readonly aiPendingActions: AiPendingActionsRepository
  ) {}
  async createIncomingCall(headers: RequestHeaders, body: unknown) {
    this.access.requireInternalSecret(headers);
    const command = CreateIncomingCallSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.findActiveByNumber(command.toNumber);
    const businessId = command.businessId ?? phoneNumber?.businessId;
    if (!businessId) {
      throw new NotFoundException("Business phone number not found");
    }

    const selectedDigit = command.selectedDigit === "1" || command.selectedDigit === "2" || command.selectedDigit === "3" ? command.selectedDigit : undefined;
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
        nextWebhook: "/plivo/reminder-request"
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
    const reminderResult = await this.executeReminderFromCall({
      businessId: incomingCall.businessId,
      incomingCallId: incomingCall.id,
      callerPhone: incomingCall.fromNumber ?? undefined,
      transcript: command.transcript,
      recordingUrl: command.recordingUrl,
      priority: command.urgent || incomingCall.urgent ? "URGENT" : "NORMAL",
      sourceCallId: incomingCall.plivoCallId,
      idempotencyKey: stableIdempotencyKey("plivo_recording", `${incomingCall.plivoCallId}:${command.urgent || incomingCall.urgent ? "urgent" : "normal"}`)
    });
    const transcript = await this.callTranscripts.create({
      businessId: incomingCall.businessId,
      incomingCallId: incomingCall.id,
      transcript: command.transcript,
      reminderId: "reminder" in reminderResult ? reminderResult.reminder.id : undefined,
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
      reminder: reminderResult
    };
  }
  async createReminderFromCall(headers: RequestHeaders, body: unknown) {
    this.access.requireInternalSecret(headers);
    const command = CreateReminderFromCallSchema.parse(body);
    return this.executeReminderFromCall(command);
  }
  async processDueReminders(headers: RequestHeaders, body: unknown) {
    await this.access.requireInternalScheduler(headers);
    const requestedLimit = Number((body as { limit?: unknown })?.limit ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const dueReminders = await this.reminders.claimDueReminders(limit);
    const processedReminders = [];

    log("info", "due reminder poll started", { limit, dueReminderCount: dueReminders.length });

    for (const reminder of dueReminders) {
      const notification = await this.notifications.create({
        businessId: reminder.businessId,
        reminderId: reminder.id,
        itemType: "reminder",
        itemId: reminder.id,
        title: "תזכורת למשימה",
        body: buildReminderReminderBody(reminder),
        payload: {
          source: "reminder_reminder",
          reminderId: reminder.id,
          dueAt: reminder.dueAt?.toISOString() ?? null,
          priority: reminder.priority
        }
      });
      const notificationDelivery = await this.notificationDelivery.sendNotification(notification);
      await this.audit.record({
        businessId: reminder.businessId,
        actorType: "system",
        source: "worker",
        entityType: "reminder",
        entityId: reminder.id,
        action: "SEND_REMINDER_NOTIFICATION",
        after: reminder as Prisma.InputJsonValue,
        result: notificationDelivery.status
      });
      processedReminders.push({
        reminder,
        notification: notificationDelivery.notification,
        notificationDelivery
      });
    }

    log("info", "due reminder poll finished", { processed: processedReminders.length });

    return {
      processed: processedReminders.length,
      reminders: processedReminders
    };
  }
  async executeOwnerAction(headers: RequestHeaders, body: unknown) {
    const request = body as { businessId?: string; action?: unknown };
    if (!request.businessId) {
      throw new BadRequestException("businessId is required");
    }

    const user = await this.access.requireBusinessAccess(headers, request.businessId);
    const action = AiActionSchema.parse(request.action);
    if (action.missingFields.length > 0) {
      const aiPendingAction = await this.aiPendingActions.create({
        businessId: request.businessId,
        userId: user.id,
        actionType: action.type,
        payload: action.payload as Prisma.InputJsonValue,
        missingFields: action.missingFields
      });
      await this.audit.record({
        businessId: request.businessId,
        actorType: "user",
        actorId: user.id,
        source: "ai_owner_command",
        entityType: "ai_pending_action",
        entityId: aiPendingAction.id,
        action: "CREATE_AI_PENDING_ACTION",
        after: aiPendingAction as Prisma.InputJsonValue
      });
      return { status: "PENDING_MISSING_INFORMATION", aiPendingAction };
    }

    if (action.type === "CREATE_REMINDER") {
      const existing = await this.reminders.findByIdempotencyKey(request.businessId, action.idempotencyKey);
      if (existing) {
        return { status: "EXECUTED", duplicate: true, reminder: existing };
      }

      const title = typeof action.payload.title === "string" ? action.payload.title : "Owner reminder";
      const reminder = await this.reminders.create({
        businessId: request.businessId,
        title,
        description: typeof action.payload.description === "string" ? action.payload.description : undefined,
        priority: "NORMAL",
        dueAt: await this.voiceActions.resolveAiReminderDueAt(request.businessId, action.payload),
        source: "ai_owner_command",
        sourceRef: action.idempotencyKey,
        idempotencyKey: action.idempotencyKey
      });
      await this.audit.record({
        businessId: request.businessId,
        actorType: "user",
        actorId: user.id,
        source: "ai_owner_command",
        entityType: "reminder",
        entityId: reminder.id,
        action: "CREATE_REMINDER_FROM_OWNER_ACTION",
        after: reminder as Prisma.InputJsonValue
      });
      return { status: "EXECUTED", duplicate: false, reminder };
    }

    return {
      status: action.requiresConfirmation ? "REVIEW_REQUIRED" : "MOCK_ACCEPTED",
      action
    };
  }
  private async executeReminderFromCall(command: {
    businessId: string;
    incomingCallId?: string;
    callerPhone?: string;
    transcript?: string;
    recordingUrl?: string;
    priority: "NORMAL" | "URGENT";
    sourceCallId: string;
    idempotencyKey: string;
  }) {
    const existing = await this.reminders.findByIdempotencyKey(command.businessId, command.idempotencyKey);
    if (existing) {
      return { duplicate: true, reminder: existing };
    }

    const urgentPrefix = command.priority === "URGENT" ? "[URGENT] " : "";
    const reminder = await this.reminders.create({
      businessId: command.businessId,
      title: `${urgentPrefix}לחזור ללקוח`,
      description: buildReminderFromCallDescription(command.callerPhone, command.transcript),
      priority: command.priority,
      dueAt: await this.voiceActions.resolveAiReminderDueAt(command.businessId, {}),
      source: "telephony",
      sourceRef: command.sourceCallId,
      idempotencyKey: command.idempotencyKey
    });

    const notification = await this.notifications.create({
      businessId: command.businessId,
      reminderId: reminder.id,
      itemType: "reminder",
      itemId: reminder.id,
      title: command.priority === "URGENT" ? "הודעת לקוח דחופה" : "בקשת חזרה ללקוח",
      body: buildReminderNotificationBody(command.callerPhone, command.transcript),
      payload: {
        source: "telephony",
        sourceCallId: command.sourceCallId,
        incomingCallId: command.incomingCallId ?? null,
        callerPhone: command.callerPhone ?? null,
        recordingUrl: command.recordingUrl ?? null,
        priority: command.priority
      }
    });
    const notificationDelivery = await this.notificationDelivery.sendNotification(notification);

    await this.audit.record({
      businessId: command.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "reminder",
      entityId: reminder.id,
      action: "CREATE_REMINDER_FROM_CALL",
      after: reminder as Prisma.InputJsonValue
    });
    await this.audit.record({
      businessId: command.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "notification",
      entityId: notification.id,
      action: "CREATE_REMINDER_NOTIFICATION",
      after: notification as Prisma.InputJsonValue,
      result: notificationDelivery.status
    });

    log("info", "reminder from call created", { businessId: command.businessId, reminderId: reminder.id });

    return { duplicate: false, reminder, notification: notificationDelivery.notification, notificationDelivery };
  }

}

const {
  AiActionsController,
  CORE_SERVICE,
  CustomersController,
  InternalController,
  NotificationsController,
  SearchController,
  SystemController,
  VoiceCommandsController,
  WorkItemsController
} = await import("./core.controllers.js");

@Module({
  controllers: [
    SystemController,
    InternalController,
    VoiceCommandsController,
    CustomersController,
    SearchController,
    WorkItemsController,
    NotificationsController,
    AiActionsController
  ],
  providers: [
    PrismaService,
    AuditRepository,
    AuthRepository,
    BusinessMembersRepository,
    BusinessesRepository,
    BusinessSettingsRepository,
    BusinessPhoneNumbersRepository,
    IncomingCallsRepository,
    CallTranscriptsRepository,
    CustomersRepository,
    RemindersRepository,
    NotesRepository,
    AppointmentsRepository,
    HomeVisitsRepository,
    QuotesRepository,
    NotificationsRepository,
    DeviceTokensRepository,
    OwnerVoiceCommandsRepository,
    AiPendingActionsRepository,
    ActionBatchesRepository,
    UserPreferencesRepository,
    CoreAccessService,
    CoreAiInternalClient,
    CoreVoiceInternalClient,
    CoreNotificationsService,
    CoreOpenAiRealtimeClient,
    CoreVoiceGatewayService,
    CoreVoiceActionsService,
    CoreWorkItemPresenter,
    CoreActionExecutionService,
    CoreVoiceResultPresenter,
    CoreAiPendingActionsApplicationService,
    CoreBusinessApplicationService,
    CoreCustomersService,
    CoreVoiceCommandsApplicationService,
    CoreWorkItemsService,
    CoreSearchService,
    CoreNotificationsApplicationService,
    CoreService,
    { provide: CORE_SERVICE, useExisting: CoreService }
  ]
})
class CoreModule {}

async function bootstrap() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(CoreModule, adapter);
  configureHttpObservability(adapter.getInstance(), "core");
  adapter.getInstance().addContentTypeParser(
    ["audio/mp4", "audio/m4a", "audio/aac", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  app.useGlobalFilters(new ApiExceptionFilter("core"));
  const port = getPort("CORE_PORT", 3000);
  await app.listen(port, "0.0.0.0");
  log("info", "core service listening", { port });
}

await bootstrap();
