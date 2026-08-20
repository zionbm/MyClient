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
  Query,
  UnauthorizedException
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Business, Prisma, User } from "@prisma/client";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import {
  AiActionBatchSchema,
  AiActionSchema,
  CreateAppointmentSchema,
  CreateBusinessPhoneNumberSchema,
  CreateCallbackTaskSchema,
  CreateCallTranscriptSchema,
  CreateCustomerNoteSchema,
  CreateCustomerSchema,
  CreateIncomingCallSchema,
  CreateJobSchema,
  CreateTaskSchema,
  CompletePendingActionSchema,
  ListByStatusQuerySchema,
  OwnerVoiceCommandHeadersSchema,
  RegisterBusinessSchema,
  RegisterDeviceTokenSchema,
  UpdateAppointmentSchema,
  UpdateBusinessPhoneNumberSchema,
  UpdateBusinessSettingsSchema,
  UpdateCustomerSchema,
  UpdateJobSchema,
  UpdateNotificationSchema,
  UpdateTaskSchema
} from "@myclient/contracts";
import type { AiAction } from "@myclient/contracts";
import {
  AppointmentsRepository,
  AuthRepository,
  AuditRepository,
  BusinessesRepository,
  BusinessPhoneNumbersRepository,
  BusinessSettingsRepository,
  CallTranscriptsRepository,
  CustomerNotesRepository,
  CustomersRepository,
  DeviceTokensRepository,
  IncomingCallsRepository,
    JobsRepository,
    NotificationsRepository,
    OwnerVoiceCommandsRepository,
  PendingActionsRepository,
  TasksRepository
} from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

type AuthenticatedUser = User & {
  business: Business;
};

type NotificationSendInput = {
  businessId: string;
  notificationId: string;
  title: string;
  body: string;
  payload?: Prisma.JsonValue | null;
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

function buildTaskReminderBody(task: { title: string; description?: string | null }) {
  return task.description ? `${task.title}\n${task.description}` : task.title;
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

function parseRequiredDate(value: string): Date {
  const parsed = parseOptionalDate(value);
  if (!parsed) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return parsed;
}

function getZonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return zonedAsUtc - date.getTime();
}

function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string) {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  return new Date(guess.getTime() - getTimeZoneOffsetMs(guess, timeZone));
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function defaultAiTaskDueAt(timeZone: string, now = new Date()) {
  const workdayStartMinutes = 9 * 60;
  const eveningCutoffMinutes = 19 * 60;
  const nowParts = getZonedParts(now, timeZone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;

  if (nowMinutes >= workdayStartMinutes && nowMinutes < eveningCutoffMinutes) {
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const inTwoHoursParts = getZonedParts(inTwoHours, timeZone);
    const inTwoHoursMinutes = inTwoHoursParts.hour * 60 + inTwoHoursParts.minute;
    const sameLocalDay =
      inTwoHoursParts.year === nowParts.year &&
      inTwoHoursParts.month === nowParts.month &&
      inTwoHoursParts.day === nowParts.day;
    if (sameLocalDay && inTwoHoursMinutes < eveningCutoffMinutes) {
      return inTwoHours;
    }
  }

  const targetDay = nowMinutes < workdayStartMinutes
    ? nowParts
    : addLocalDays(nowParts, 1);
  return zonedTimeToUtc({
    year: targetDay.year,
    month: targetDay.month,
    day: targetDay.day,
    hour: 9,
    minute: 0
  }, timeZone);
}

function parseAiDueAt(value: string, timeZone: string) {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    return parseRequiredDate(value);
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    return parseRequiredDate(value);
  }

  return zonedTimeToUtc({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  }, timeZone);
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

function requireAudioBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new BadRequestException("Audio body is required");
  }
  if (body.byteLength > 5 * 1024 * 1024) {
    throw new BadRequestException("Audio body is too large");
  }
  return body;
}

function notificationProviderName() {
  return getEnv("MOCK_FCM_PROVIDER", "true") === "true" ? "mock-fcm" : "firebase-fcm";
}

function notificationPayloadData(payload: Prisma.JsonValue | null | undefined, notificationId: string) {
  const data: Record<string, string> = {
    notificationId
  };
  if (payload !== undefined && payload !== null) {
    data.payload = JSON.stringify(payload);
  }
  return data;
}

function publicDeviceToken(deviceToken: {
  id: string;
  businessId: string;
  userId: string;
  platform: string | null;
  appVersion: string | null;
  status: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: deviceToken.id,
    businessId: deviceToken.businessId,
    userId: deviceToken.userId,
    platform: deviceToken.platform,
    appVersion: deviceToken.appVersion,
    status: deviceToken.status,
    lastSeenAt: deviceToken.lastSeenAt,
    createdAt: deviceToken.createdAt,
    updatedAt: deviceToken.updatedAt
  };
}

async function sendFirebaseMulticast(tokens: string[], input: NotificationSendInput) {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }

  return getMessaging().sendEachForMulticast({
    tokens,
    notification: {
      title: input.title,
      body: input.body
    },
    data: notificationPayloadData(input.payload, input.notificationId)
  });
}

@Controller()
class CoreController {
  constructor(
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CallTranscriptsRepository) private readonly callTranscripts: CallTranscriptsRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(CustomerNotesRepository) private readonly customerNotes: CustomerNotesRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(DeviceTokensRepository) private readonly deviceTokens: DeviceTokensRepository,
    @Inject(OwnerVoiceCommandsRepository) private readonly ownerVoiceCommands: OwnerVoiceCommandsRepository,
    @Inject(PendingActionsRepository) private readonly pendingActions: PendingActionsRepository
  ) {}

  @Get("health")
  health() {
    return health("core", { database: "postgresql-prisma", notifications: notificationProviderName() });
  }

  @Post("auth/register-business")
  async registerBusiness(@Body() body: unknown) {
    const command = RegisterBusinessSchema.parse(body);
    const result = await this.auth.registerBusiness(command);
    await this.settings.getByBusiness(result.business.id);
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

  @Get("businesses/:businessId/settings")
  async getSettings(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { settings: await this.settings.getByBusiness(businessId) };
  }

  @Patch("businesses/:businessId/settings")
  async updateSettings(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateBusinessSettingsSchema.parse(body);
    const before = await this.settings.getByBusiness(businessId);
    const settings = await this.settings.update({
      businessId,
      locale: command.locale,
      timezone: command.timezone,
      greetingText: command.greetingText,
      callbackPrompt: command.callbackPrompt,
      urgentPrompt: command.urgentPrompt,
      workingHours: command.workingHours as Prisma.InputJsonValue | null | undefined,
      notificationPhone: command.notificationPhone,
      allowUrgentCalls: command.allowUrgentCalls
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_settings",
      entityId: settings.id,
      action: "UPDATE_SETTINGS",
      before: before as Prisma.InputJsonValue,
      after: settings as Prisma.InputJsonValue
    });
    return { settings };
  }

  @Get("businesses/:businessId/phone-numbers")
  async listPhoneNumbers(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { phoneNumbers: await this.phoneNumbers.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/phone-numbers")
  async createPhoneNumber(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateBusinessPhoneNumberSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.create({
      businessId,
      plivoNumber: command.plivoNumber,
      displayName: command.displayName,
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_phone_number",
      entityId: phoneNumber.id,
      action: "CREATE_PHONE_NUMBER",
      after: phoneNumber as Prisma.InputJsonValue
    });
    return { phoneNumber };
  }

  @Patch("businesses/:businessId/phone-numbers/:phoneNumberId")
  async updatePhoneNumber(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("phoneNumberId") phoneNumberId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateBusinessPhoneNumberSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.update({
      businessId,
      phoneNumberId,
      displayName: command.displayName,
      status: command.status
    });
    if (!phoneNumber) {
      throw new NotFoundException("Phone number not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_phone_number",
      entityId: phoneNumber.id,
      action: "UPDATE_PHONE_NUMBER",
      after: phoneNumber as Prisma.InputJsonValue
    });
    return { phoneNumber };
  }

  @Post("internal/telephony/incoming")
  async createIncomingCall(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
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
        prompt: settings.callbackPrompt ?? "אנא ציין את שמך ואת מספר הטלפון לחזרה אחרי הצליל."
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
        mode: "CREATE_CALLBACK_WITHOUT_RECORDING",
        nextWebhook: "/plivo/callback-request"
      };
    }

    return {
      businessId,
      incomingCall,
      mode: "RECORD_MESSAGE",
      urgent: selectedDigit === "3",
      prompt: selectedDigit === "3" ? settings.urgentPrompt : settings.callbackPrompt,
      maxSeconds: 60,
      finishOnKey: "#"
    };
  }

  @Post("internal/telephony/recording")
  async createCallTranscript(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
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
    const callbackResult = await this.executeCallbackTask({
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
      taskId: "task" in callbackResult ? callbackResult.task.id : undefined,
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
      callback: callbackResult
    };
  }

  @Post("internal/tasks/callback")
  async createCallbackTask(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
    const command = CreateCallbackTaskSchema.parse(body);
    return this.executeCallbackTask(command);
  }

  @Post("internal/reminders/due")
  async processDueReminders(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
    const requestedLimit = Number((body as { limit?: unknown })?.limit ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const tasks = await this.tasks.listDueReminders(limit);
    const reminders = [];

    for (const task of tasks) {
      const notification = await this.notifications.create({
        businessId: task.businessId,
        taskId: task.id,
        title: "תזכורת למשימה",
        body: buildTaskReminderBody(task),
        payload: {
          source: "task_reminder",
          taskId: task.id,
          dueAt: task.dueAt?.toISOString() ?? null,
          priority: task.priority
        }
      });
      const notificationDelivery = await this.sendNotification(notification);
      const updatedTask = await this.tasks.markReminderSent(task.id);
      await this.audit.record({
        businessId: task.businessId,
        actorType: "system",
        source: "worker",
        entityType: "task",
        entityId: task.id,
        action: "SEND_TASK_REMINDER",
        after: updatedTask as Prisma.InputJsonValue,
        result: notificationDelivery.status
      });
      reminders.push({
        task: updatedTask,
        notification: notificationDelivery.notification,
        notificationDelivery
      });
    }

    return {
      processed: reminders.length,
      reminders
    };
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
      await this.audit.record({
        businessId: request.businessId,
        actorType: "user",
        actorId: user.id,
        source: "ai_owner_command",
        entityType: "pending_action",
        entityId: pending.id,
        action: "CREATE_PENDING_ACTION",
        after: pending as Prisma.InputJsonValue
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
        dueAt: await this.resolveAiTaskDueAt(request.businessId, action.payload),
        source: "ai_owner_command",
        sourceRef: action.idempotencyKey,
        idempotencyKey: action.idempotencyKey
      });
      await this.audit.record({
        businessId: request.businessId,
        actorType: "user",
        actorId: user.id,
        source: "ai_owner_command",
        entityType: "task",
        entityId: task.id,
        action: "CREATE_TASK_FROM_OWNER_ACTION",
        after: task as Prisma.InputJsonValue
      });
      return { status: "EXECUTED", duplicate: false, task };
    }

    return {
      status: action.requiresConfirmation ? "REVIEW_REQUIRED" : "MOCK_ACCEPTED",
      action
    };
  }

  @Get("businesses/:businessId/voice-commands")
  async listOwnerVoiceCommands(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { voiceCommands: await this.ownerVoiceCommands.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/voice-commands/audio")
  async createOwnerVoiceCommandFromAudio(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const audio = requireAudioBody(body);
    const commandHeaders = OwnerVoiceCommandHeadersSchema.parse({
      idempotencyKey: headerValue(headers, "x-idempotency-key"),
      languageCode: headerValue(headers, "x-language-code") ?? "he-IL",
      filename: headerValue(headers, "x-audio-filename") ?? "owner-command.m4a"
    });
    const existing = await this.ownerVoiceCommands.findByIdempotencyKey(commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: commandHeaders.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      const stt = await this.transcribeOwnerCommandAudio({
        audio,
        contentType: headerValue(headers, "content-type") ?? "audio/mp4",
        filename: commandHeaders.filename,
        languageCode: commandHeaders.languageCode
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: stt.transcript,
        sttProvider: stt.provider,
        sttConfidence: stt.confidence,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.parseOwnerCommandIntent({
        transcript: stt.transcript,
        businessId,
        userId: user.id,
        idempotencyKey: commandHeaders.idempotencyKey
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        llmProvider: intent.provider,
        llmAction: { actions: intent.actions } as Prisma.InputJsonValue,
        executionStatus: "PARSED"
      });

      const execution = await this.executeVoiceCommandActions({
        businessId,
        userId: user.id,
        actions: intent.actions
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: execution.status,
        executionResult: execution as Prisma.InputJsonValue
      });
      await this.audit.record({
        businessId,
        actorType: "user",
        actorId: user.id,
        source: "owner_voice_command",
        entityType: "owner_voice_command",
        entityId: voiceCommand.id,
        action: "EXECUTE_OWNER_VOICE_COMMAND",
        after: voiceCommand as Prisma.InputJsonValue
      });

      return {
        duplicate: false,
        voiceCommand,
        stt,
        llm: intent,
        execution
      };
    } catch (error) {
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: "FAILED",
        executionResult: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      await this.audit.record({
        businessId,
        actorType: "user",
        actorId: user.id,
        source: "owner_voice_command",
        entityType: "owner_voice_command",
        entityId: voiceCommand.id,
        action: "FAIL_OWNER_VOICE_COMMAND",
        after: voiceCommand as Prisma.InputJsonValue,
        result: "FAILED"
      });
      throw error;
    }
  }

  @Get("businesses/:businessId/tasks")
  async listTasks(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { tasks: await this.tasks.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/tasks")
  async createTask(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
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
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "task",
      entityId: task.id,
      action: "CREATE_TASK",
      after: task as Prisma.InputJsonValue
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
    const user = await this.requireBusinessAccess(headers, businessId);
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

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "task",
      entityId: task.id,
      action: "UPDATE_TASK",
      after: task as Prisma.InputJsonValue
    });
    return { task };
  }

  @Post("businesses/:businessId/tasks/:taskId/complete")
  async completeTask(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("taskId") taskId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const task = await this.tasks.complete(businessId, taskId);
    if (!task) {
      throw new NotFoundException("Task not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "task",
      entityId: task.id,
      action: "COMPLETE_TASK",
      after: task as Prisma.InputJsonValue
    });
    return { task };
  }

  @Post("businesses/:businessId/customers")
  async createCustomer(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateCustomerSchema.parse(body);
    const customer = await this.customers.create({
      businessId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: customer.id,
      action: "CREATE_CUSTOMER",
      after: customer as Prisma.InputJsonValue
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
    const user = await this.requireBusinessAccess(headers, businessId);
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

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: customer.id,
      action: "UPDATE_CUSTOMER",
      after: customer as Prisma.InputJsonValue
    });
    return { customer };
  }

  @Post("businesses/:businessId/customers/:customerId/notes")
  async createCustomerNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateCustomerNoteSchema.parse(body);
    const note = await this.customerNotes.create({
      businessId,
      customerId,
      text: command.text
    });

    if (!note) {
      throw new NotFoundException("Customer not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer_note",
      entityId: note.id,
      action: "CREATE_CUSTOMER_NOTE",
      after: note as Prisma.InputJsonValue
    });
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

  @Get("businesses/:businessId/calls")
  async listIncomingCalls(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { calls: await this.incomingCalls.listByBusiness(businessId) };
  }

  @Get("businesses/:businessId/appointments")
  async listAppointments(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { appointments: await this.appointments.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/appointments")
  async createAppointment(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateAppointmentSchema.parse(body);
    const appointment = await this.appointments.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      startsAt: parseRequiredDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt)
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "CREATE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  @Patch("businesses/:businessId/appointments/:appointmentId")
  async updateAppointment(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("appointmentId") appointmentId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateAppointmentSchema.parse(body);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      customerId: command.customerId,
      title: command.title,
      startsAt: command.startsAt ? parseRequiredDate(command.startsAt) : undefined,
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "UPDATE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  @Post("businesses/:businessId/appointments/:appointmentId/cancel")
  async cancelAppointment(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("appointmentId") appointmentId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      status: "CANCELLED"
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "CANCEL_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  @Post("businesses/:businessId/appointments/:appointmentId/complete")
  async completeAppointment(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("appointmentId") appointmentId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      status: "COMPLETED"
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "COMPLETE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  @Get("businesses/:businessId/jobs")
  async listJobs(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { jobs: await this.jobs.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/jobs")
  async createJob(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateJobSchema.parse(body);
    const job = await this.jobs.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "job",
      entityId: job.id,
      action: "CREATE_JOB",
      after: job as Prisma.InputJsonValue
    });
    return { job };
  }

  @Patch("businesses/:businessId/jobs/:jobId")
  async updateJob(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateJobSchema.parse(body);
    const job = await this.jobs.update({
      businessId,
      jobId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      status: command.status
    });
    if (!job) {
      throw new NotFoundException("Job not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "job",
      entityId: job.id,
      action: "UPDATE_JOB",
      after: job as Prisma.InputJsonValue
    });
    return { job };
  }

  @Get("businesses/:businessId/notifications")
  async listNotifications(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = ListByStatusQuerySchema.parse(query);
    return { notifications: await this.notifications.listByBusinessAndStatus(businessId, command.status) };
  }

  @Post("businesses/:businessId/device-tokens")
  async registerDeviceToken(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = RegisterDeviceTokenSchema.parse(body);
    const deviceToken = await this.deviceTokens.register({
      businessId,
      userId: user.id,
      token: command.token,
      platform: command.platform,
      appVersion: command.appVersion
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "device_token",
      entityId: deviceToken.id,
      action: "REGISTER_DEVICE_TOKEN",
      after: {
        id: deviceToken.id,
        platform: deviceToken.platform,
        appVersion: deviceToken.appVersion,
        status: deviceToken.status,
        lastSeenAt: deviceToken.lastSeenAt
      } as Prisma.InputJsonValue
    });
    return { deviceToken: publicDeviceToken(deviceToken) };
  }

  @Patch("businesses/:businessId/notifications/:notificationId")
  async updateNotification(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("notificationId") notificationId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateNotificationSchema.parse(body);
    const notification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: command.status,
      failureReason: command.failureReason
    });
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      entityId: notification.id,
      action: `MARK_NOTIFICATION_${command.status}`,
      after: notification as Prisma.InputJsonValue
    });
    return { notification };
  }

  @Get("businesses/:businessId/pending-actions")
  async listPendingActions(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = ListByStatusQuerySchema.parse(query);
    return { pendingActions: await this.pendingActions.listByBusinessAndStatus(businessId, command.status) };
  }

  @Post("businesses/:businessId/pending-actions/:pendingActionId/reject")
  async rejectPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("pendingActionId") pendingActionId: string
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const pending = await this.pendingActions.resolve({
      businessId,
      pendingActionId,
      status: "REJECTED",
      resolution: { rejectedBy: user.id }
    });
    if (!pending) {
      throw new NotFoundException("Pending action not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "pending_action",
      entityId: pending.id,
      action: "REJECT_PENDING_ACTION",
      after: pending as Prisma.InputJsonValue
    });
    return { pendingAction: pending };
  }

  @Post("businesses/:businessId/pending-actions/:pendingActionId/complete")
  async completePendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("pendingActionId") pendingActionId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CompletePendingActionSchema.parse(body);
    const existing = await this.pendingActions.findByBusinessAndId(businessId, pendingActionId);
    if (!existing) {
      throw new NotFoundException("Pending action not found");
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("Pending action is already resolved");
    }

    const payload = {
      ...(existing.payload as Record<string, unknown>),
      ...(command.payload ?? {})
    };
    const execution = await this.executeStructuredAction({
      businessId,
      userId: user.id,
      actionType: existing.actionType,
      payload,
      idempotencyKey: stableIdempotencyKey("pending_action", existing.id)
    });
    const pending = await this.pendingActions.resolve({
      businessId,
      pendingActionId,
      status: "EXECUTED",
      resolution: {
        executedBy: user.id,
        execution
      } as Prisma.InputJsonValue
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "pending_action",
      entityId: pending?.id,
      action: "COMPLETE_PENDING_ACTION",
      after: pending as Prisma.InputJsonValue
    });
    return { pendingAction: pending, execution };
  }

  @Get("businesses/:businessId/audit-events")
  async listAuditEvents(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { auditEvents: await this.audit.listByBusiness(businessId) };
  }

  private async executeStructuredAction(input: {
    businessId: string;
    userId: string;
    actionType: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    if (input.actionType === "CREATE_TASK") {
      const existing = await this.tasks.findByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) {
        return { type: input.actionType, duplicate: true, task: existing };
      }
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!title) {
        throw new BadRequestException("Pending action payload is missing task title");
      }
      const task = await this.tasks.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : "NORMAL",
        dueAt: await this.resolveAiTaskDueAt(input.businessId, input.payload),
        source: "pending_action",
        sourceRef: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "pending_action",
        entityType: "task",
        entityId: task.id,
        action: "CREATE_TASK_FROM_PENDING_ACTION",
        after: task as Prisma.InputJsonValue
      });
      return { type: input.actionType, duplicate: false, task };
    }

    if (input.actionType === "CREATE_CUSTOMER") {
      const name = typeof input.payload.name === "string" ? input.payload.name : undefined;
      if (!name) {
        throw new BadRequestException("Pending action payload is missing customer name");
      }
      const customer = await this.customers.create({
        businessId: input.businessId,
        name,
        phone: typeof input.payload.phone === "string" ? input.payload.phone : undefined,
        email: typeof input.payload.email === "string" ? input.payload.email : undefined,
        address: typeof input.payload.address === "string" ? input.payload.address : undefined
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "pending_action",
        entityType: "customer",
        entityId: customer.id,
        action: "CREATE_CUSTOMER_FROM_PENDING_ACTION",
        after: customer as Prisma.InputJsonValue
      });
      return { type: input.actionType, customer };
    }

    if (input.actionType === "CREATE_JOB") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!customerId || !title) {
        throw new BadRequestException("Pending action payload is missing job customerId or title");
      }
      const job = await this.jobs.create({
        businessId: input.businessId,
        customerId,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        status: typeof input.payload.status === "string" ? input.payload.status : undefined
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "pending_action",
        entityType: "job",
        entityId: job.id,
        action: "CREATE_JOB_FROM_PENDING_ACTION",
        after: job as Prisma.InputJsonValue
      });
      return { type: input.actionType, job };
    }

    if (input.actionType === "CREATE_APPOINTMENT") {
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      const startsAt = typeof input.payload.startsAt === "string" ? input.payload.startsAt : undefined;
      if (!title || !startsAt) {
        throw new BadRequestException("Pending action payload is missing appointment title or startsAt");
      }
      const appointment = await this.appointments.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        startsAt: parseRequiredDate(startsAt),
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "pending_action",
        entityType: "appointment",
        entityId: appointment.id,
        action: "CREATE_APPOINTMENT_FROM_PENDING_ACTION",
        after: appointment as Prisma.InputJsonValue
      });
      return { type: input.actionType, appointment };
    }

    if (input.actionType === "ADD_CUSTOMER_NOTE") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      const text = typeof input.payload.text === "string" ? input.payload.text : undefined;
      if (!customerId || !text) {
        throw new BadRequestException("Pending action payload is missing note customerId or text");
      }
      const note = await this.customerNotes.create({
        businessId: input.businessId,
        customerId,
        text
      });
      if (!note) {
        throw new NotFoundException("Customer not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "pending_action",
        entityType: "customer_note",
        entityId: note.id,
        action: "CREATE_CUSTOMER_NOTE_FROM_PENDING_ACTION",
        after: note as Prisma.InputJsonValue
      });
      return { type: input.actionType, note };
    }

    return {
      type: input.actionType,
      status: "MOCK_ACCEPTED",
      payload: input.payload
    };
  }

  private async transcribeOwnerCommandAudio(input: {
    audio: Buffer;
    contentType: string;
    filename: string;
    languageCode: string;
  }): Promise<{ provider: string; model?: string; languageCode: string; transcript: string; confidence: number }> {
    const voiceBaseUrl = getEnv("VOICE_BASE_URL", "http://localhost:3002");
    const audioBody = input.audio.buffer.slice(input.audio.byteOffset, input.audio.byteOffset + input.audio.byteLength) as ArrayBuffer;
    const response = await fetch(`${voiceBaseUrl}/stt/openai`, {
      method: "POST",
      headers: {
        "content-type": input.contentType,
        "x-audio-filename": input.filename,
        "x-language-code": input.languageCode
      },
      body: audioBody
    });
    const result = (await response.json().catch(() => ({}))) as {
      provider?: string;
      model?: string;
      languageCode?: string;
      transcript?: string;
      confidence?: number;
    };
    if (!response.ok) {
      throw new BadRequestException({
        message: `Voice STT failed with ${response.status}`,
        details: result
      });
    }
    if (!result.transcript) {
      throw new BadRequestException("Voice STT returned empty transcript");
    }
    return {
      provider: result.provider ?? "openai",
      model: result.model,
      languageCode: result.languageCode ?? input.languageCode,
      transcript: result.transcript,
      confidence: result.confidence ?? 1
    };
  }

  private async parseOwnerCommandIntent(input: {
    transcript: string;
    businessId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    const aiBaseUrl = getEnv("AI_BASE_URL", "http://localhost:3001");
    const response = await fetch(`${aiBaseUrl}/intent/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: input.transcript,
        businessId: input.businessId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey
      })
    });
    const result = (await response.json().catch(() => ({}))) as { provider?: string; action?: unknown; actions?: unknown };
    if (!response.ok) {
      throw new BadRequestException({
        message: `AI intent parsing failed with ${response.status}`,
        details: result
      });
    }
    const actions = result.actions
      ? AiActionBatchSchema.parse({ actions: result.actions }).actions
      : [AiActionSchema.parse(result.action)];
    return {
      provider: result.provider ?? "openai",
      action: actions[0],
      actions
    };
  }

  private async executeVoiceCommandActions(input: {
    businessId: string;
    userId: string;
    actions: AiAction[];
  }) {
    const results = [];
    const createdCustomers: Array<{ id: string; name?: string | null; phone?: string | null }> = [];

    for (const action of input.actions) {
      const payload = this.resolveVoiceActionPayload(action.payload, createdCustomers);
      if (action.missingFields.length > 0 || action.requiresConfirmation) {
        const pending = await this.pendingActions.create({
          businessId: input.businessId,
          userId: input.userId,
          actionType: action.type,
          payload: payload as Prisma.InputJsonValue,
          missingFields: action.missingFields
        });
        await this.audit.record({
          businessId: input.businessId,
          actorType: "user",
          actorId: input.userId,
          source: "owner_voice_command",
          entityType: "pending_action",
          entityId: pending.id,
          action: "CREATE_PENDING_ACTION_FROM_VOICE_COMMAND",
          after: pending as Prisma.InputJsonValue
        });
        results.push({ status: "PENDING", actionType: action.type, idempotencyKey: action.idempotencyKey, pendingAction: pending });
        continue;
      }

      const result = await this.executeStructuredAction({
        businessId: input.businessId,
        userId: input.userId,
        actionType: action.type,
        payload,
        idempotencyKey: action.idempotencyKey
      });

      if (action.type === "CREATE_CUSTOMER" && "customer" in result && result.customer) {
        createdCustomers.push(result.customer);
      }
      results.push({ status: "EXECUTED", actionType: action.type, idempotencyKey: action.idempotencyKey, result });
    }

    const hasPending = results.some((result) => result.status === "PENDING");
    return {
      status: hasPending ? "PARTIAL_PENDING" : "EXECUTED",
      results
    };
  }

  private resolveVoiceActionPayload(
    payload: Record<string, unknown>,
    createdCustomers: Array<{ id: string; name?: string | null; phone?: string | null }>
  ): Record<string, unknown> {
    if (typeof payload.customerId === "string" || createdCustomers.length === 0) {
      return payload;
    }

    const phone = typeof payload.phone === "string" ? payload.phone : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const matchingCustomer = createdCustomers.find((customer) =>
      (phone && customer.phone === phone) || (name && customer.name === name)
    ) ?? createdCustomers.at(-1);

    return matchingCustomer ? { ...payload, customerId: matchingCustomer.id } : payload;
  }

  private async resolveAiTaskDueAt(businessId: string, payload: Record<string, unknown>) {
    const settings = await this.settings.getByBusiness(businessId);
    if (typeof payload.dueAt === "string") {
      return parseAiDueAt(payload.dueAt, settings.timezone);
    }

    return defaultAiTaskDueAt(settings.timezone);
  }

  private async executeCallbackTask(command: {
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
        incomingCallId: command.incomingCallId ?? null,
        callerPhone: command.callerPhone ?? null,
        recordingUrl: command.recordingUrl ?? null,
        priority: command.priority
      }
    });
    const notificationDelivery = await this.sendNotification(notification);

    await this.audit.record({
      businessId: command.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "task",
      entityId: task.id,
      action: "CREATE_CALLBACK_TASK",
      after: task as Prisma.InputJsonValue
    });
    await this.audit.record({
      businessId: command.businessId,
      actorType: "system",
      source: "telephony",
      entityType: "notification",
      entityId: notification.id,
      action: "CREATE_CALLBACK_NOTIFICATION",
      after: notification as Prisma.InputJsonValue,
      result: notificationDelivery.status
    });

    log("info", "callback task created", { businessId: command.businessId, taskId: task.id });

    return { duplicate: false, task, notification: notificationDelivery.notification, notificationDelivery };
  }

  private async sendNotification(notification: {
    id: string;
    businessId: string;
    title: string;
    body: string;
    payload: Prisma.JsonValue | null;
  }) {
    if (getEnv("MOCK_FCM_PROVIDER", "true") === "true") {
      const sent = await this.notifications.updateStatus({
        businessId: notification.businessId,
        notificationId: notification.id,
        status: "SENT"
      });
      return { provider: "mock-fcm", status: "SENT", notification: sent ?? notification };
    }

    const tokens = await this.deviceTokens.listActiveByBusiness(notification.businessId);
    if (tokens.length === 0) {
      const failed = await this.notifications.updateStatus({
        businessId: notification.businessId,
        notificationId: notification.id,
        status: "FAILED",
        failureReason: "No active FCM device tokens"
      });
      return { provider: "firebase-fcm", status: "FAILED", notification: failed ?? notification };
    }

    const response = await sendFirebaseMulticast(tokens.map((deviceToken) => deviceToken.token), {
      businessId: notification.businessId,
      notificationId: notification.id,
      title: notification.title,
      body: notification.body,
      payload: notification.payload
    });

    await Promise.all(response.responses.map((result, index) =>
      result.success
        ? Promise.resolve()
        : this.deviceTokens.deactivate(tokens[index].token)
    ));

    const failedCount = response.failureCount;
    const sent = await this.notifications.updateStatus({
      businessId: notification.businessId,
      notificationId: notification.id,
      status: response.successCount > 0 ? "SENT" : "FAILED",
      failureReason: failedCount > 0 ? `${failedCount} FCM deliveries failed` : undefined
    });

    return {
      provider: "firebase-fcm",
      status: response.successCount > 0 ? "SENT" : "FAILED",
      successCount: response.successCount,
      failureCount: response.failureCount,
      notification: sent ?? notification
    };
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
    AuditRepository,
    AuthRepository,
    BusinessesRepository,
    BusinessSettingsRepository,
    BusinessPhoneNumbersRepository,
    IncomingCallsRepository,
    CallTranscriptsRepository,
    CustomersRepository,
    TasksRepository,
    CustomerNotesRepository,
    AppointmentsRepository,
    JobsRepository,
    NotificationsRepository,
    DeviceTokensRepository,
    OwnerVoiceCommandsRepository,
    PendingActionsRepository
  ]
})
class CoreModule {}

async function bootstrap() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(CoreModule, adapter);
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
