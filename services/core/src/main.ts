import "reflect-metadata";
import {
  BadRequestException,
  Injectable,
  HttpException,
  Inject,
  Module,
  NotFoundException
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Prisma } from "@prisma/client";
import { ApiExceptionFilter, getEnv, getInternalApiSecret, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import {
  AiPendingActionListQuerySchema,
  AiActionBatchSchema,
  AiActionSchema,
  CreateBusinessMemberSchema,
  CreateAppointmentSchema,
  CreateBusinessPhoneNumberSchema,
  CreateReminderFromCallSchema,
  CreateCallTranscriptSchema,
  CreateNoteSchema,
  CreateCustomerSchema,
  CreateHomeVisitSchema,
  CreateIncomingCallSchema,
  CreateQuoteSchema,
  CreateReminderSchema,
  ApproveAiPendingActionSchema,
  HomeQuerySchema,
  MergeCustomerSchema,
  NotificationListQuerySchema,
  OwnerVoiceCommandHeadersSchema,
  OwnerVoiceCommandTranscriptSchema,
  PaginationQuerySchema,
  RegisterBusinessSchema,
  RegisterDeviceTokenSchema,
  SnoozeNotificationSchema,
  UpdateAppointmentSchema,
  UpdateBusinessPhoneNumberSchema,
  UpdateBusinessSettingsSchema,
  UpdateNoteSchema,
  UpdateCustomerSchema,
  UpdateHomeVisitSchema,
  UpdateNotificationSchema,
  UpdateAiPendingActionSchema,
  UpdateQuoteSchema,
  UpdateReminderSchema
} from "@myclient/contracts";
import type { AiAction, VoiceCommandResult } from "@myclient/contracts";
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
  QuotesRepository,
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
import {
  addUtcDays,
  authProviderName,
  buildReminderFromCallDescription,
  buildReminderNotificationBody,
  buildReminderReminderBody,
  callDisplayStatus,
  callIvrSelection,
  defaultAiReminderDueAt,
  headerValue,
  homeVisitStatus,
  isSameUtcInstant,
  notificationProviderName,
  paginatedResponse,
  paginationFromParsedQuery,
  paginationFromQuery,
  parseAiDueAt,
  parseHebrewRelativeDueAt,
  parseHebrewVoiceDueAt,
  parseOptionalAmount,
  parseOptionalDate,
  parseRequiredDate,
  publicCustomer,
  publicDeviceToken,
  reminderStatus,
  requireAudioBody,
  scheduledTimeOrZero,
  snoozeDueAt,
  startOfLocalDate,
  tryParseAiDueAt,
  type RequestHeaders,
  type VoiceCommandExecutionResult
} from "./core-utils.js";

@Injectable()
export class CoreService {
  constructor(
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreNotificationsService) private readonly notificationDelivery: CoreNotificationsService,
    @Inject(CoreVoiceGatewayService) private readonly voiceGateway: CoreVoiceGatewayService,
    @Inject(CoreWorkItemPresenter) private readonly workItemPresenter: CoreWorkItemPresenter,
    @Inject(CoreActionExecutionService) private readonly actionExecution: CoreActionExecutionService,
    @Inject(CoreVoiceResultPresenter) private readonly voiceResultPresenter: CoreVoiceResultPresenter,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessMembersRepository) private readonly members: BusinessMembersRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CallTranscriptsRepository) private readonly callTranscripts: CallTranscriptsRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(NotesRepository) private readonly notes: NotesRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(HomeVisitsRepository) private readonly homeVisits: HomeVisitsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(DeviceTokensRepository) private readonly deviceTokens: DeviceTokensRepository,
    @Inject(OwnerVoiceCommandsRepository) private readonly ownerVoiceCommands: OwnerVoiceCommandsRepository,
    @Inject(AiPendingActionsRepository) private readonly aiPendingActions: AiPendingActionsRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}
  health() {
    return health("core", {
      database: "postgresql-prisma",
      auth: authProviderName(),
      notifications: notificationProviderName()
    });
  }
  async registerBusiness(headers: RequestHeaders, body: unknown) {
    const command = RegisterBusinessSchema.parse(body);
    const verifiedAuth = await this.access.verifyAuth(headers, {
      mockFallback: command.firebaseUid
    });
    const email = command.email ?? verifiedAuth.email;
    const phoneNumber = command.phoneNumber ?? verifiedAuth.phoneNumber;
    const displayName = command.displayName ?? verifiedAuth.displayName ?? email ?? phoneNumber;
    const isMockAuth = authProviderName() === "mock";
    const mockDisplayName = displayName ?? command.firebaseUid ?? verifiedAuth.firebaseUid;
    if (!mockDisplayName) {
      throw new BadRequestException("Display name is required when it is not present in the Firebase token");
    }
    if (!email && !phoneNumber && !isMockAuth) {
      throw new BadRequestException("Phone number or email is required");
    }

    const result = await this.auth.registerBusiness({
      firebaseUid: verifiedAuth.firebaseUid,
      email,
      phoneNumber,
      displayName: mockDisplayName,
      businessName: command.businessName
    });
    if (!result.business) {
      throw new BadRequestException("Existing user is not linked to a business");
    }
    await this.settings.getByBusiness(result.business.id);
    return {
      created: result.created,
      business: result.business,
      user: {
        id: result.user.id,
        businessId: result.user.businessId,
        email: result.user.email,
        phoneNumber: result.user.phoneNumber,
        displayName: result.user.displayName,
        firebaseUid: result.user.firebaseUid,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt
      }
    };
  }
  async me(headers: RequestHeaders) {
    const user = await this.access.requireAuthenticatedUser(headers);
    const membership = user.memberships?.[0] ?? null;
    const business = membership?.business ?? user.business;
    return {
      user: {
        id: user.id,
        businessId: user.businessId,
        email: user.email,
        phoneNumber: user.phoneNumber,
        displayName: user.displayName,
        firebaseUid: user.firebaseUid,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      business,
      membership: membership ? {
        businessId: membership.businessId,
        memberType: membership.memberType,
        status: membership.status
      } : null,
      onboardingState: business ? "HAS_BUSINESS" : "NEEDS_CHOICE"
    };
  }
  async getSettings(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { settings: await this.settings.getByBusiness(businessId) };
  }
  async updateSettings(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateBusinessSettingsSchema.parse(body);
    const before = await this.settings.getByBusiness(businessId);
    const settings = await this.settings.update({
      businessId,
      actorUserId: user.id,
      businessName: command.businessName,
      ownerDisplayName: command.ownerDisplayName,
      locale: command.locale,
      timezone: command.timezone,
      greetingText: command.greetingText,
      reminderPrompt: command.reminderPrompt,
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
  async listMembers(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { members: await this.members.listByBusiness(businessId) };
  }
  async createMember(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateBusinessMemberSchema.parse(body);
    const member = await this.members.upsertByPhone({
      businessId,
      phoneNumber: command.phoneNumber,
      displayName: command.displayName,
      memberType: command.memberType,
      addedByUserId: user.id
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_member",
      entityId: member.id,
      action: "UPSERT_BUSINESS_MEMBER",
      after: member as Prisma.InputJsonValue
    });
    return { member };
  }
  async disableMember(headers: RequestHeaders, businessId: string, memberId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const member = await this.members.disable({ businessId, memberId });
    if (!member) {
      throw new NotFoundException("Business member not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_member",
      entityId: member.id,
      action: "DISABLE_BUSINESS_MEMBER",
      after: member as Prisma.InputJsonValue
    });
    return { member };
  }
  async listPhoneNumbers(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { phoneNumbers: await this.phoneNumbers.listByBusiness(businessId) };
  }
  async createPhoneNumber(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
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
  async updatePhoneNumber(
    headers: RequestHeaders,
    businessId: string,
    phoneNumberId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
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
        dueAt: await this.resolveAiReminderDueAt(request.businessId, action.payload),
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
  async listOwnerVoiceCommands(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.ownerVoiceCommands.listByBusiness(businessId, pagination), pagination.limit);
    return { voiceCommands: page.items, pageInfo: page.pageInfo };
  }
  async createOwnerVoiceRealtimeSession(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const apiKey = getEnv("OPENAI_API_KEY", "");
    if (!apiKey) {
      throw new BadRequestException("OpenAI API key is not configured");
    }
    const model = getEnv("OPENAI_REALTIME_TRANSCRIPTION_MODEL", "gpt-live-transcribe");
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: {
                model,
                language: "he",
                prompt: "עברית ישראלית. פקודות קצרות לניהול לקוחות, תזכורות, ביקורי בית, הצעות מחיר והערות לקוח."
              }
            }
          }
        }
      })
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      log("error", "openai realtime client secret failed", {
        status: response.status,
        error: json
      });
      throw new BadRequestException("לא הצלחנו להכין הקלטה קולית");
    }
    const value = typeof json.value === "string" ? json.value : "";
    const expiresAt = typeof json.expires_at === "number" ? json.expires_at : 0;
    if (!value || !expiresAt) {
      throw new BadRequestException("OpenAI realtime session response is invalid");
    }
    return { value, expiresAt, model };
  }
  async createOwnerVoiceCommandFromTranscript(
    headers: RequestHeaders,
    businessId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const commandHeaders = OwnerVoiceCommandHeadersSchema.parse({
      idempotencyKey: headerValue(headers, "x-idempotency-key"),
      languageCode: headerValue(headers, "x-language-code") ?? "he-IL"
    });
    const transcriptBody = OwnerVoiceCommandTranscriptSchema.parse(body);
    const existing = await this.ownerVoiceCommands.findByBusinessAndIdempotencyKey(businessId, commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult,
        voiceResult: this.voiceResultPresenter.fromStoredCommand(existing)
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: transcriptBody.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      if (this.voiceResultPresenter.isInvalidTranscript(transcriptBody.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: transcriptBody.transcript,
        sttProvider: transcriptBody.sttProvider,
        sttConfidence: transcriptBody.sttConfidence ?? undefined,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.voiceGateway.parseOwnerCommandIntent({
        transcript: transcriptBody.transcript,
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
        transcript: transcriptBody.transcript,
        actions: intent.actions
      });
      const settings = await this.settings.getByBusiness(businessId);
      const voiceResult = this.voiceResultPresenter.buildResult({
        transcript: transcriptBody.transcript,
        execution,
        timeZone: settings.timezone
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: execution.status,
        executionResult: { ...execution, voiceResult } as Prisma.InputJsonValue
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
        stt: {
          transcript: transcriptBody.transcript,
          provider: transcriptBody.sttProvider,
          confidence: transcriptBody.sttConfidence ?? null
        },
        llm: intent,
        execution,
        voiceResult
      };
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const voiceResult = this.voiceResultPresenter.buildFailedResult({
        transcript: voiceCommand.transcript,
        message
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: "FAILED",
        executionResult: {
          message,
          voiceResult,
          ...(typeof response === "object" && response !== null ? { details: response } : {})
        } as Prisma.InputJsonValue
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
      return {
        duplicate: false,
        voiceCommand,
        execution: voiceCommand.executionResult,
        voiceResult
      };
    }
  }
  async createOwnerVoiceCommandFromAudio(
    headers: RequestHeaders,
    businessId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const audio = requireAudioBody(body);
    const commandHeaders = OwnerVoiceCommandHeadersSchema.parse({
      idempotencyKey: headerValue(headers, "x-idempotency-key"),
      languageCode: headerValue(headers, "x-language-code") ?? "he-IL",
      filename: headerValue(headers, "x-audio-filename") ?? "owner-command.m4a"
    });
    const existing = await this.ownerVoiceCommands.findByBusinessAndIdempotencyKey(businessId, commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult,
        voiceResult: this.voiceResultPresenter.fromStoredCommand(existing)
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: commandHeaders.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      const stt = await this.voiceGateway.transcribeOwnerCommandAudio({
        audio,
        contentType: headerValue(headers, "content-type") ?? "audio/mp4",
        filename: commandHeaders.filename,
        languageCode: commandHeaders.languageCode
      });
      if (this.voiceResultPresenter.isInvalidTranscript(stt.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: stt.transcript,
        sttProvider: stt.provider,
        sttConfidence: stt.confidence,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.voiceGateway.parseOwnerCommandIntent({
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
        transcript: stt.transcript,
        actions: intent.actions
      });
      const settings = await this.settings.getByBusiness(businessId);
      const voiceResult = this.voiceResultPresenter.buildResult({
        transcript: stt.transcript,
        execution,
        timeZone: settings.timezone
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: execution.status,
        executionResult: { ...execution, voiceResult } as Prisma.InputJsonValue
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
        execution,
        voiceResult
      };
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const voiceResult = this.voiceResultPresenter.buildFailedResult({
        transcript: voiceCommand.transcript,
        message
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: "FAILED",
        executionResult: {
          message,
          voiceResult,
          ...(typeof response === "object" && response !== null ? { details: response } : {})
        } as Prisma.InputJsonValue
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
      return {
        duplicate: false,
        voiceCommand,
        execution: voiceCommand.executionResult,
        voiceResult
      };
    }
  }
  async listNotifications(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = NotificationListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(await this.notifications.listByBusinessAndStatus(businessId, command.status, pagination), pagination.limit);
    return { notifications: page.items, pageInfo: page.pageInfo };
  }
  async registerDeviceToken(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
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
  async updateNotification(
    headers: RequestHeaders,
    businessId: string,
    notificationId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
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
  async markNotificationRead(headers: RequestHeaders, businessId: string, notificationId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const notification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: "READ"
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
      action: "MARK_NOTIFICATION_READ",
      after: notification as Prisma.InputJsonValue
    });
    return { notification };
  }
  async markAllNotificationsRead(headers: RequestHeaders, businessId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const result = await this.notifications.markAllRead(businessId);
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      action: "MARK_ALL_NOTIFICATIONS_READ",
      after: result as Prisma.InputJsonValue
    });
    return { updatedCount: result.count };
  }
  async snoozeNotification(
    headers: RequestHeaders,
    businessId: string,
    notificationId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = SnoozeNotificationSchema.parse(body);
    const notification = await this.notifications.findByBusinessAndId(businessId, notificationId);
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    const settings = await this.settings.getByBusiness(businessId);
    const dueAt = snoozeDueAt(command.preset, settings.timezone);
    const itemType = notification.itemType ?? (notification.reminderId ? "reminder" : null);
    const itemId = notification.itemId ?? notification.reminderId;
    if (!itemType || !itemId) {
      throw new BadRequestException("Notification is not linked to a snoozable item");
    }

    let item: unknown;
    if (itemType === "reminder") {
      item = await this.reminders.snooze(businessId, itemId, dueAt);
    } else if (itemType === "quote") {
      item = await this.quotes.snooze(businessId, itemId, dueAt);
    } else {
      throw new BadRequestException("Notification item is not snoozable");
    }
    if (!item) {
      throw new NotFoundException("Snoozable item not found");
    }
    const readNotification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: "READ"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      entityId: notification.id,
      action: "SNOOZE_NOTIFICATION",
      after: { notification: readNotification, item, dueAt: dueAt.toISOString() } as Prisma.InputJsonValue
    });
    return { notification: readNotification, item, dueAt };
  }
  async listAiPendingActions(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = AiPendingActionListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(await this.aiPendingActions.listByBusinessAndStatus(businessId, command.status, pagination), pagination.limit);
    return { aiPendingActions: page.items, pageInfo: page.pageInfo };
  }
  async updateAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateAiPendingActionSchema.parse(body);
    const aiPendingAction = await this.aiPendingActions.update({
      businessId,
      aiPendingActionId,
      payload: command.payload as Prisma.InputJsonValue | undefined,
      missingFields: command.missingFields,
      reviewReason: command.reviewReason
    });
    if (!aiPendingAction) {
      throw new NotFoundException("AI pending action not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "ai_pending_action",
      entityId: aiPendingAction.id,
      action: "UPDATE_AI_PENDING_ACTION",
      after: aiPendingAction as Prisma.InputJsonValue
    });
    return { aiPendingAction };
  }
  async rejectAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const existing = await this.aiPendingActions.findByBusinessAndId(businessId, aiPendingActionId);
    if (!existing) {
      throw new NotFoundException("AI pending action not found");
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("AI pending action is already resolved");
    }
    const aiPendingAction = await this.aiPendingActions.resolve({
      businessId,
      aiPendingActionId,
      expectedStatus: "PENDING",
      status: "REJECTED",
      resolution: { rejectedBy: user.id }
    });
    if (!aiPendingAction) {
      throw new BadRequestException("AI pending action is already resolved");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "ai_pending_action",
      entityId: aiPendingAction.id,
      action: "REJECT_AI_PENDING_ACTION",
      after: aiPendingAction as Prisma.InputJsonValue
    });
    return { aiPendingAction };
  }
  async approveAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = ApproveAiPendingActionSchema.parse(body);
    const claimed = await this.aiPendingActions.claimForExecution({
      businessId,
      aiPendingActionId,
      userId: user.id
    });
    if (!claimed) {
      const existing = await this.aiPendingActions.findByBusinessAndId(businessId, aiPendingActionId);
      if (!existing) {
        throw new NotFoundException("AI pending action not found");
      }
      throw new BadRequestException("AI pending action is already resolved");
    }

    try {
      let payload = {
        ...(claimed.payload as Record<string, unknown>),
        ...(command.payload ?? {})
      };
      payload = this.normalizeVoiceActionPayload(claimed.actionType, payload);
      payload = await this.resolveVoiceActionReferences({
        businessId,
        actionType: claimed.actionType,
        payload,
        transcript: ""
      });
      const execution = await this.actionExecution.execute({
        businessId,
        userId: user.id,
        actionType: claimed.actionType,
        payload,
        idempotencyKey: stableIdempotencyKey("ai_pending_action", claimed.id),
        resolveDueAt: (targetBusinessId, actionPayload) => this.resolveAiReminderDueAt(targetBusinessId, actionPayload)
      });
      const aiPendingAction = await this.aiPendingActions.resolve({
        businessId,
        aiPendingActionId,
        expectedStatus: "EXECUTING",
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
        entityType: "ai_pending_action",
        entityId: aiPendingAction?.id,
        action: "APPROVE_AI_PENDING_ACTION",
        after: aiPendingAction as Prisma.InputJsonValue
      });
      return { aiPendingAction, execution };
    } catch (error) {
      await this.aiPendingActions.releaseExecutionClaim({
        businessId,
        aiPendingActionId,
        reason: error instanceof Error ? error.message : "Unknown approval error"
      });
      throw error;
    }
  }
  async listAuditEvents(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.audit.listByBusiness(businessId, pagination), pagination.limit);
    return { auditEvents: page.items, pageInfo: page.pageInfo };
  }

  private async executeVoiceCommandActions(input: {
    businessId: string;
    userId: string;
    transcript: string;
    actions: AiAction[];
  }) {
    const results = [];
    const settings = await this.settings.getByBusiness(input.businessId);
    const actions = this.applyVoiceCustomerAddressHints(input.actions, input.transcript);

    for (const action of actions) {
      let payload = this.resolveVoiceActionPayload(action.payload, []);
      payload = this.enrichVoiceActionPayload(action, payload, input.transcript, settings.timezone);
      payload = this.normalizeVoiceActionPayload(action.type, payload);
      payload = await this.resolveVoiceActionReferences({
        businessId: input.businessId,
        actionType: action.type,
        payload,
        transcript: input.transcript
      });
      const missingFields = this.requiredVoiceMissingFields(action, payload);
      const aiPendingAction = await this.aiPendingActions.create({
        businessId: input.businessId,
        userId: input.userId,
        actionType: action.type,
        payload: payload as Prisma.InputJsonValue,
        missingFields
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "owner_voice_command",
        entityType: "ai_pending_action",
        entityId: aiPendingAction.id,
        action: "CREATE_AI_PENDING_ACTION_FROM_VOICE_COMMAND",
        after: aiPendingAction as Prisma.InputJsonValue
      });
      results.push({ status: "PENDING", actionType: action.type, idempotencyKey: action.idempotencyKey, aiPendingAction });
    }

    const hasPending = results.some((result) => result.status === "PENDING");
    return {
      status: hasPending ? "PARTIAL_PENDING" : "EXECUTED",
      results
    };
  }

  private applyVoiceCustomerAddressHints(actions: AiAction[], transcript: string): AiAction[] {
    const oneOffLocationHint = /(?:אתר|אתר עבודה|דירה להשכרה|אצל אמא|אצל אימא|אצל אבא|אצל ההורים|במשרד|בעסק|במחסן)/.test(transcript);
    if (oneOffLocationHint) {
      return actions;
    }

    return actions.map((action, index) => {
      if (action.type !== "CREATE_CUSTOMER" || typeof action.payload.address === "string") {
        return action;
      }

      const name = this.normalizedVoiceText(action.payload.name);
      const phone = this.normalizedVoiceText(action.payload.phone);
      if (!name && !phone) {
        return action;
      }

      const laterLocation = actions.slice(index + 1)
        .map((candidate) => ({
          type: candidate.type,
          payload: this.normalizeVoiceActionPayload(candidate.type, candidate.payload)
        }))
        .find((candidate) => {
          if (candidate.type !== "CREATE_HOME_VISIT" && candidate.type !== "CREATE_APPOINTMENT") {
            return false;
          }
          const candidateName = this.normalizedVoiceText(candidate.payload.name);
          const candidatePhone = this.normalizedVoiceText(candidate.payload.phone);
          return (name && candidateName === name) || (phone && candidatePhone === phone);
        })?.payload.location;

      return typeof laterLocation === "string"
        ? { ...action, payload: { ...action.payload, address: laterLocation } }
        : action;
    });
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

  private normalizeVoiceActionPayload(actionType: string, payload: Record<string, unknown>) {
    const normalized = { ...payload };

    if (actionType === "CREATE_HOME_VISIT" ||
      actionType === "UPDATE_HOME_VISIT" ||
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "UPDATE_APPOINTMENT") {
      if (typeof normalized.location !== "string" && typeof normalized.address === "string") {
        normalized.location = normalized.address;
      }
      if (typeof normalized.notes !== "string" && typeof normalized.description === "string") {
        normalized.notes = normalized.description;
      }
      if (typeof normalized.title !== "string") {
        normalized.title = typeof normalized.notes === "string"
          ? `ביקור בית - ${normalized.notes}`
          : actionType === "CREATE_HOME_VISIT" || actionType === "UPDATE_HOME_VISIT"
            ? "ביקור בית"
            : "פגישה";
      }
    }

    if ((actionType === "CREATE_REMINDER" || actionType === "CREATE_REMINDER") &&
      typeof normalized.title !== "string" &&
      typeof normalized.text === "string") {
      normalized.title = normalized.text;
    }

    if ((actionType === "CREATE_QUOTE" || actionType === "UPDATE_QUOTE") &&
      typeof normalized.title !== "string") {
      const description = typeof normalized.description === "string" ? normalized.description : undefined;
      const subject = description?.match(/(?:על|עבור)\s+(.+)$/)?.[1]?.trim();
      if (subject) {
        normalized.title = subject;
      }
    }

    if (actionType === "CREATE_NOTE" &&
      typeof normalized.text !== "string" &&
      typeof normalized.description === "string") {
      normalized.text = normalized.description;
    }

    return normalized;
  }

  private async resolveVoiceActionReferences(input: {
    businessId: string;
    actionType: string;
    payload: Record<string, unknown>;
    transcript: string;
  }): Promise<Record<string, unknown>> {
    let payload = input.payload;

    if (this.voiceActionNeedsCustomer(input.actionType, payload)) {
      const customer = await this.resolveVoiceCustomer(input.businessId, payload);
      if (customer) {
        payload = { ...payload, customerId: customer.id };
      }
    }

    if (this.voiceActionNeedsReminder(input.actionType, payload)) {
      const reminder = await this.resolveVoiceReminder(input.businessId, payload, input.transcript);
      if (reminder) {
        payload = { ...payload, reminderId: reminder.id };
      }
    }

    return payload;
  }

  private voiceActionNeedsCustomer(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.customerId === "string") {
      return false;
    }
    return actionType === "UPDATE_CUSTOMER" ||
      actionType === "CREATE_NOTE" ||
      actionType === "CREATE_REMINDER" ||
      actionType === "CREATE_HOME_VISIT" ||
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "COMPLETE_REMINDER";
  }

  private voiceActionNeedsReminder(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.reminderId === "string") {
      return false;
    }
    return actionType === "COMPLETE_REMINDER";
  }

  private async resolveVoiceCustomer(businessId: string, payload: Record<string, unknown>) {
    const phone = this.normalizedVoiceText(payload.phone);
    const email = this.normalizedVoiceText(payload.email);
    const name = this.normalizedVoiceText(payload.name);

    if (phone) {
      const byPhone = await this.findUniqueVoiceCustomer(businessId, { phone });
      if (byPhone) return byPhone;
    }

    if (email) {
      const byEmail = await this.findUniqueVoiceCustomer(businessId, { email });
      if (byEmail) return byEmail;
    }

    if (name) {
      const byName = await this.findUniqueVoiceCustomer(businessId, { name });
      if (byName) return byName;
    }

    return null;
  }

  private async findUniqueVoiceCustomer(
    businessId: string,
    criteria: { phone?: string; email?: string; name?: string }
  ) {
    const customers = await this.prisma.customer.findMany({
      where: {
        businessId,
        deletedAt: null,
        mergedIntoCustomerId: null,
        ...(criteria.phone ? { phone: criteria.phone } : {}),
        ...(criteria.email ? { email: { equals: criteria.email, mode: "insensitive" as const } } : {}),
        ...(criteria.name ? { name: criteria.name } : {})
      },
      take: 2
    });
    return customers.length === 1 ? customers[0] : null;
  }

  private async resolveVoiceReminder(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    const title = this.normalizedVoiceText(payload.title);
    const text = this.normalizedVoiceText(payload.text);
    const lookupText = this.normalizedVoiceText([title, text, transcript].filter(Boolean).join(" "));

    const reminders = await this.prisma.reminder.findMany({
      where: {
        businessId,
        deletedAt: null,
        status: "OPEN",
        customerId
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 20
    });

    if (reminders.length === 1) {
      return reminders[0];
    }

    const matchingReminders = reminders.filter((reminder) => {
      const normalizedTitle = this.normalizedVoiceText(reminder.title);
      const haystack = this.normalizedVoiceText([
        reminder.title,
        reminder.description,
        reminder.customer?.name,
        reminder.customer?.phone
      ].filter(Boolean).join(" "));
      return Boolean(lookupText && haystack && (
        lookupText.includes(haystack) ||
        haystack.includes(lookupText) ||
        normalizedTitle && lookupText.includes(normalizedTitle)
      ));
    });

    return matchingReminders.length === 1 ? matchingReminders[0] : null;
  }

  private normalizedVoiceText(value: unknown) {
    return typeof value === "string" ? value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : undefined;
  }

  private enrichVoiceActionPayload(action: AiAction, payload: Record<string, unknown>, transcript: string, timeZone: string) {
    const normalized = { ...payload };

    if (this.voiceActionUsesDueAt(action.type)) {
      const dueAt = this.normalizeVoiceDateValue(normalized.dueAt, transcript, timeZone);
      if (dueAt) {
        normalized.dueAt = dueAt.toISOString();
      } else if (typeof normalized.dueAt === "string") {
        delete normalized.dueAt;
      }
    }

    if (this.voiceActionUsesStartsAt(action.type)) {
      const startsAt = this.normalizeVoiceDateValue(normalized.startsAt, transcript, timeZone);
      if (startsAt) {
        normalized.startsAt = startsAt.toISOString();
      } else if (typeof normalized.startsAt === "string") {
        delete normalized.startsAt;
      }

      const endsAt = typeof normalized.endsAt === "string"
        ? tryParseAiDueAt(normalized.endsAt, timeZone)
        : undefined;
      if (endsAt) {
        normalized.endsAt = endsAt.toISOString();
      } else if (typeof normalized.endsAt === "string") {
        delete normalized.endsAt;
      }
    }

    if ((action.type === "CREATE_QUOTE" || action.type === "UPDATE_QUOTE") &&
      typeof normalized.title !== "string") {
      const subject = transcript.match(/(?:על|עבור)\s+(.+?)(?:[.!?。]|$)/)?.[1]?.trim();
      if (subject) {
        normalized.title = subject;
      }
    }

    return normalized;
  }

  private normalizeVoiceDateValue(value: unknown, transcript: string, timeZone: string) {
    const relativeFromTranscript = parseHebrewRelativeDueAt(transcript);
    if (relativeFromTranscript) {
      return relativeFromTranscript;
    }

    if (typeof value === "string") {
      const parsed = tryParseAiDueAt(value, timeZone);
      if (parsed) {
        return parsed;
      }
      const parsedFromValue = parseHebrewVoiceDueAt(value, timeZone);
      if (parsedFromValue) {
        return parsedFromValue;
      }
    }

    return parseHebrewVoiceDueAt(transcript, timeZone);
  }

  private voiceActionUsesDueAt(actionType: string) {
    return actionType === "CREATE_REMINDER" ||
      actionType === "UPDATE_REMINDER" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "UPDATE_QUOTE";
  }

  private voiceActionUsesStartsAt(actionType: string) {
    return actionType === "CREATE_APPOINTMENT" ||
      actionType === "UPDATE_APPOINTMENT" ||
      actionType === "CREATE_HOME_VISIT" ||
      actionType === "UPDATE_HOME_VISIT";
  }

  private requiredVoiceMissingFields(action: AiAction, payload: Record<string, unknown>) {
    const fields = new Set(action.missingFields);
    if (this.voiceActionUsesStartsAt(action.type) && payload.startsAt === undefined) {
      fields.add("startsAt");
    }
    if ((action.type === "CREATE_QUOTE" || action.type === "UPDATE_QUOTE") && payload.title === undefined) {
      fields.add("title");
    }
    return [...fields].filter((field) => !this.isOptionalVoiceField(action.type, field) && payload[field] === undefined);
  }

  private isOptionalVoiceField(actionType: string, field: string) {
    if (field === "dueAt") {
      return actionType === "CREATE_REMINDER";
    }

    if (field === "phone") {
      return actionType === "CREATE_CUSTOMER" || actionType === "CREATE_REMINDER";
    }

    return false;
  }

  private async resolveAiReminderDueAt(businessId: string, payload: Record<string, unknown>) {
    const settings = await this.settings.getByBusiness(businessId);
    if (typeof payload.dueAt === "string") {
      return parseAiDueAt(payload.dueAt, settings.timezone);
    }

    return defaultAiReminderDueAt(settings.timezone);
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
      dueAt: await this.resolveAiReminderDueAt(command.businessId, {}),
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
    CoreAccessService,
    CoreNotificationsService,
    CoreVoiceGatewayService,
    CoreWorkItemPresenter,
    CoreActionExecutionService,
    CoreVoiceResultPresenter,
    CoreCustomersService,
    CoreWorkItemsService,
    CoreService,
    { provide: CORE_SERVICE, useExisting: CoreService }
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
