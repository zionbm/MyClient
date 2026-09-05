import { Global, Module } from "@nestjs/common";
import {
  ActionBatchesRepository,
  AiPendingActionsRepository,
  AssistantSessionsRepository,
  AuditRepository,
  AuthRepository,
  BusinessMembersRepository,
  BusinessPhoneNumbersRepository,
  BusinessesRepository,
  BusinessSettingsRepository,
  CallTranscriptsRepository,
  DeviceTokensRepository,
  IncomingCallsRepository,
  NotificationsRepository,
  UserPreferencesRepository,
  ActivitiesRepository,
  AmountsRepository,
  CustomerPhonesRepository,
  CustomersRepository,
  NotesRepository,
  ServiceAddressesRepository,
  TasksRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreBusinessApplicationService } from "./core-business-application.service.js";
import { CoreCallsService } from "./core-calls.service.js";
import { CoreAiInternalClient, CoreVoiceInternalClient } from "./core-internal-clients.service.js";
import { CoreNotificationsApplicationService } from "./core-notifications-application.service.js";
import { CoreNotificationsService } from "./core-notifications.service.js";
import { CoreOpenAiRealtimeClient } from "./core-openai-realtime-client.service.js";
import { CoreActionBatchesService } from "./core-action-batches.service.js";
import { CoreActivitiesService } from "./core-activities.service.js";
import { CoreAmountsService } from "./core-amounts.service.js";
import { CoreAssistantService } from "./core-assistant.service.js";
import { CoreCustomersService } from "./core-customers.service.js";
import { CoreIdempotencyService } from "./core-idempotency.service.js";
import { CoreNotesService } from "./core-notes.service.js";
import { CoreSearchService } from "./core-search.service.js";
import { CoreTasksService } from "./core-tasks.service.js";
import { PrismaService } from "./prisma.service.js";

const repositories = [
  PrismaService,
  AuditRepository,
  AuthRepository,
  BusinessMembersRepository,
  BusinessesRepository,
  BusinessSettingsRepository,
  BusinessPhoneNumbersRepository,
  IncomingCallsRepository,
  CallTranscriptsRepository,
  NotificationsRepository,
  DeviceTokensRepository,
  AiPendingActionsRepository,
  ActionBatchesRepository,
  AssistantSessionsRepository,
  UserPreferencesRepository,
  CustomersRepository,
  NotesRepository,
  CustomerPhonesRepository,
  ServiceAddressesRepository,
  TasksRepository,
  ActivitiesRepository,
  AmountsRepository
];

@Global()
@Module({ providers: repositories, exports: repositories })
export class CorePersistenceModule {}

const infrastructure = [
  CoreAccessService,
  CoreAiInternalClient,
  CoreVoiceInternalClient,
  CoreNotificationsService,
  CoreOpenAiRealtimeClient
];

@Global()
@Module({ providers: infrastructure, exports: infrastructure })
export class CoreInfrastructureModule {}

const services = [
  CoreIdempotencyService,
  CoreCustomersService,
  CoreNotesService,
  CoreTasksService,
  CoreAssistantService,
  CoreActivitiesService,
  CoreSearchService,
  CoreAmountsService,
  CoreActionBatchesService
];

@Global()
@Module({ providers: services, exports: services })
export class CoreProductModule {}

const applicationServices = [CoreBusinessApplicationService, CoreCallsService, CoreNotificationsApplicationService];

@Global()
@Module({ providers: applicationServices, exports: applicationServices })
export class CoreApplicationModule {}
