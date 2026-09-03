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
  V2ActivitiesRepository,
  V2AmountsRepository,
  V2CustomerPhonesRepository,
  V2CustomersRepository,
  V2NotesRepository,
  V2ServiceAddressesRepository,
  V2TasksRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreBusinessApplicationService } from "./core-business-application.service.js";
import { CoreCallsService } from "./core-calls.service.js";
import { CoreAiInternalClient, CoreVoiceInternalClient } from "./core-internal-clients.service.js";
import { CoreNotificationsApplicationService } from "./core-notifications-application.service.js";
import { CoreNotificationsService } from "./core-notifications.service.js";
import { CoreOpenAiRealtimeClient } from "./core-openai-realtime-client.service.js";
import { CoreV2ActionBatchesService } from "./core-v2-action-batches.service.js";
import { CoreV2ActivitiesService } from "./core-v2-activities.service.js";
import { CoreV2AmountsService } from "./core-v2-amounts.service.js";
import { CoreV2AssistantService } from "./core-v2-assistant.service.js";
import { CoreV2CustomersService } from "./core-v2-customers.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import { CoreV2NotesService } from "./core-v2-notes.service.js";
import { CoreV2SearchService } from "./core-v2-search.service.js";
import { CoreV2TasksService } from "./core-v2-tasks.service.js";
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
  V2CustomersRepository,
  V2NotesRepository,
  V2CustomerPhonesRepository,
  V2ServiceAddressesRepository,
  V2TasksRepository,
  V2ActivitiesRepository,
  V2AmountsRepository
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

const v2Services = [
  CoreV2IdempotencyService,
  CoreV2CustomersService,
  CoreV2NotesService,
  CoreV2TasksService,
  CoreV2AssistantService,
  CoreV2ActivitiesService,
  CoreV2SearchService,
  CoreV2AmountsService,
  CoreV2ActionBatchesService
];

@Global()
@Module({ providers: v2Services, exports: v2Services })
export class CoreV2Module {}

const applicationServices = [CoreBusinessApplicationService, CoreCallsService, CoreNotificationsApplicationService];

@Global()
@Module({ providers: applicationServices, exports: applicationServices })
export class CoreApplicationModule {}
