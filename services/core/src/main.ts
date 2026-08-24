import "reflect-metadata";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
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
import { Prisma, type Business, type User } from "@prisma/client";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { ApiExceptionFilter, getEnv, getPort, health, log, stableIdempotencyKey } from "@myclient/common";
import {
  AiActionBatchSchema,
  AiActionSchema,
  CreateBusinessMemberSchema,
  CreateAppointmentSchema,
  CreateBusinessPhoneNumberSchema,
  CreateCallbackSchema,
  CreateCallbackTaskSchema,
  CreateCallTranscriptSchema,
  CreateCustomerNoteSchema,
  CreateCustomerSchema,
  CreateHomeVisitSchema,
  CreateIncomingCallSchema,
  CreateJobSchema,
  CreateQuoteSchema,
  CreateTaskSchema,
  CompletePendingActionSchema,
  HomeQuerySchema,
  ListByStatusQuerySchema,
  MergeCustomerSchema,
  OwnerVoiceCommandHeadersSchema,
  RegisterBusinessSchema,
  RegisterDeviceTokenSchema,
  SnoozeNotificationSchema,
  UpdateAppointmentSchema,
  UpdateBusinessPhoneNumberSchema,
  UpdateBusinessSettingsSchema,
  UpdateCallbackSchema,
  UpdateCustomerNoteSchema,
  UpdateCustomerSchema,
  UpdateHomeVisitSchema,
  UpdateJobSchema,
  UpdateNotificationSchema,
  UpdatePendingActionSchema,
  UpdateQuoteSchema,
  UpdateTaskSchema
} from "@myclient/contracts";
import type { AiAction } from "@myclient/contracts";
import {
  AppointmentsRepository,
  AuthRepository,
  AuditRepository,
  BusinessMembersRepository,
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
  QuotesRepository,
  TasksRepository
} from "./core.repositories.js";
import { PrismaService } from "./prisma.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

type AuthenticatedUser = User & {
  business: Business | null;
  memberships?: Array<{ businessId: string; memberType: string; status: string; business?: Business }>;
};

type VerifiedAuth = {
  firebaseUid: string;
  email?: string;
  phoneNumber?: string;
  displayName?: string;
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

function timeOrZero(value: string | number | Date | null | undefined) {
  return value ? new Date(value).getTime() : 0;
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

function parseHebrewVoiceDueAt(text: string, timeZone: string, now = new Date()) {
  const dayMatch = text.match(/(?:ביום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|\b(מחר)\b/);
  const timeMatch = text.match(/בשעה\s+([0-9]{1,2}|אחת|אחד|שתיים|שניים|שתים|שתי|שני|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|אחת עשרה|שתים עשרה|שתיים עשרה)/);
  if (!dayMatch || !timeMatch) {
    return undefined;
  }

  const weekday = dayMatch[2] === "מחר" ? undefined : dayMatch[1];
  const nowParts = getZonedParts(now, timeZone);
  const currentWeekday = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)).getUTCDay();
  const targetWeekday = weekday ? {
    "ראשון": 0,
    "שני": 1,
    "שלישי": 2,
    "רביעי": 3,
    "חמישי": 4,
    "שישי": 5,
    "שבת": 6
  }[weekday] : undefined;
  const daysAhead = dayMatch[2] === "מחר"
    ? 1
    : targetWeekday === undefined
      ? undefined
      : (targetWeekday - currentWeekday + 7) % 7 || 7;
  if (daysAhead === undefined) {
    return undefined;
  }

  const hour = parseHebrewHour(timeMatch[1], text);
  if (hour === undefined) {
    return undefined;
  }

  const targetDay = addLocalDays(nowParts, daysAhead);
  return zonedTimeToUtc({
    year: targetDay.year,
    month: targetDay.month,
    day: targetDay.day,
    hour,
    minute: 0
  }, timeZone);
}

function parseHebrewHour(value: string, context: string) {
  const numeric = Number(value);
  let hour = Number.isFinite(numeric) && numeric > 0 ? numeric : {
    "אחת": 1,
    "אחד": 1,
    "שתיים": 2,
    "שניים": 2,
    "שתים": 2,
    "שתי": 2,
    "שני": 2,
    "שלוש": 3,
    "שלושה": 3,
    "ארבע": 4,
    "ארבעה": 4,
    "חמש": 5,
    "חמישה": 5,
    "שש": 6,
    "שישה": 6,
    "שבע": 7,
    "שבעה": 7,
    "שמונה": 8,
    "תשע": 9,
    "תשעה": 9,
    "עשר": 10,
    "עשרה": 10,
    "אחת עשרה": 11,
    "שתים עשרה": 12,
    "שתיים עשרה": 12
  }[value];
  if (hour === undefined || hour > 23) {
    return undefined;
  }
  if (context.includes("בבוקר")) {
    return hour;
  }
  if ((context.includes("בצהריים") || context.includes("אחר הצהריים") || context.includes("בערב")) && hour < 12) {
    return hour + 12;
  }
  if (hour >= 1 && hour <= 7) {
    return hour + 12;
  }
  return hour;
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

function authProviderName() {
  return getEnv("AUTH_PROVIDER", "mock");
}

function firebaseApp() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
}

function parseBearerToken(headers: RequestHeaders): string {
  const authorization = headerValue(headers, "authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }

  const token = authorization.slice(prefix.length).trim();
  if (!token) {
    throw new UnauthorizedException("Missing or invalid authorization token");
  }

  return token;
}

function displayNameFromToken(decoded: DecodedIdToken): string | undefined {
  const value = decoded.name ?? decoded.email;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function publicCustomer(customer: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null } | null | undefined) {
  if (!customer) {
    return null;
  }
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    address: customer.address ?? null
  };
}

function callbackStatus(status: string) {
  return status === "COMPLETED" ? "DONE" : "OPEN";
}

function homeVisitStatus(status: string) {
  return status === "COMPLETED" ? "DONE" : "OPEN";
}

function startOfLocalDate(dateText: string | undefined, timeZone: string) {
  const nowParts = getZonedParts(new Date(), timeZone);
  const match = dateText?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parts = match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0 }, timeZone);
}

function isSameUtcInstant(a: Date, b: Date) {
  return a.getTime() === b.getTime();
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function snoozeDueAt(preset: "IN_15_MINUTES" | "IN_2_HOURS" | "TOMORROW_09_00", timeZone: string, now = new Date()) {
  if (preset === "IN_15_MINUTES") {
    return new Date(now.getTime() + 15 * 60 * 1000);
  }
  if (preset === "IN_2_HOURS") {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
  }
  const parts = addLocalDays(getZonedParts(now, timeZone), 1);
  return zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 9, minute: 0 }, timeZone);
}

function parseOptionalAmount(value: string | number | Prisma.Decimal | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Prisma.Decimal(value);
}

function callIvrSelection(call: { selectedDigit?: string | null }) {
  if (call.selectedDigit === "1") return "CALLBACK_REQUESTED";
  if (call.selectedDigit === "2") return "MESSAGE_RECORDED";
  if (call.selectedDigit === "3") return "URGENT_MESSAGE";
  return "NO_SELECTION";
}

function callDisplayStatus(call: { selectedDigit?: string | null; transcripts?: Array<{ taskId?: string | null }> }) {
  if (call.transcripts?.some((transcript) => transcript.taskId)) {
    return "TASK_CREATED";
  }
  if (call.selectedDigit) {
    return "NO_ACTION";
  }
  return "NO_ACTION";
}

async function sendFirebaseMulticast(tokens: string[], input: NotificationSendInput) {
  firebaseApp();

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
    @Inject(BusinessMembersRepository) private readonly members: BusinessMembersRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CallTranscriptsRepository) private readonly callTranscripts: CallTranscriptsRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository,
    @Inject(CustomerNotesRepository) private readonly customerNotes: CustomerNotesRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(DeviceTokensRepository) private readonly deviceTokens: DeviceTokensRepository,
    @Inject(OwnerVoiceCommandsRepository) private readonly ownerVoiceCommands: OwnerVoiceCommandsRepository,
    @Inject(PendingActionsRepository) private readonly pendingActions: PendingActionsRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  @Get("health")
  health() {
    return health("core", {
      database: "postgresql-prisma",
      auth: authProviderName(),
      notifications: notificationProviderName()
    });
  }

  @Post("auth/register-business")
  async registerBusiness(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    const command = RegisterBusinessSchema.parse(body);
    const verifiedAuth = await this.verifyAuth(headers, {
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

  @Get("auth/me")
  async me(@Headers() headers: RequestHeaders) {
    const user = await this.requireAuthenticatedUser(headers);
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
      actorUserId: user.id,
      businessName: command.businessName,
      ownerDisplayName: command.ownerDisplayName,
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

  @Get("businesses/:businessId/members")
  async listMembers(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { members: await this.members.listByBusiness(businessId) };
  }

  @Post("businesses/:businessId/members")
  async createMember(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/members/:memberId/disable")
  async disableMember(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("memberId") memberId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
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
        itemType: "callback",
        itemId: task.id,
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
      if (this.isInvalidOwnerVoiceTranscript(stt.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
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
        transcript: stt.transcript,
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
      const response = error instanceof HttpException ? error.getResponse() : undefined;
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: "FAILED",
        executionResult: {
          message: error instanceof Error ? error.message : String(error),
          ...(typeof response === "object" && response !== null ? { details: response } : {})
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

  @Get("businesses/:businessId/home")
  async getHome(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = HomeQuerySchema.parse(query);
    const settings = await this.settings.getByBusiness(businessId);
    const start = startOfLocalDate(command.date, settings.timezone);
    const end = addUtcDays(start, 1);
    const includeOpenBeforeStart = isSameUtcInstant(start, startOfLocalDate(undefined, settings.timezone));
    const [callbacks, homeVisits, quotes, notifications] = await Promise.all([
      command.filter === "home_visits" || command.filter === "quotes" || command.filter === "calls"
        ? Promise.resolve([])
        : this.tasks.listCallbacksForDate({ businessId, start, end, search: command.search, urgentOnly: command.filter === "urgent", includeOpenBeforeStart }),
      command.filter === "callbacks" || command.filter === "quotes" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.appointments.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "callbacks" || command.filter === "home_visits" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.quotes.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "all" || command.filter === "urgent"
        ? this.notifications.listByBusinessAndStatus(businessId, "SENT")
        : Promise.resolve([])
    ]);

    const notificationItems = notifications
      .filter((notification) => !notification.readAt)
      .slice(0, 20)
      .map((notification) => ({
        id: notification.id,
        type: "notification",
        title: notification.title,
        description: notification.body,
        dueAt: notification.createdAt,
        priority: "NORMAL",
        status: notification.status,
        source: "notification",
        customer: null,
        linkedEntity: {
          type: notification.itemType ?? (notification.taskId ? "callback" : "notification"),
          id: notification.itemId ?? notification.taskId ?? notification.id
        },
        actions: ["open", "mark_read"]
      }));

    const items = [
      ...callbacks.map((task) => this.publicCallbackWorkItem(task)),
      ...homeVisits.map((appointment) => this.publicHomeVisitWorkItem(appointment)),
      ...quotes.map((quote) => this.publicQuoteWorkItem(quote)),
      ...notificationItems
    ].sort((a, b) => {
      const priority = Number(b.priority === "URGENT") - Number(a.priority === "URGENT");
      if (priority !== 0) return priority;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });

    return {
      date: command.date ?? start.toISOString().slice(0, 10),
      filter: command.filter,
      items
    };
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

  @Get("businesses/:businessId/callbacks")
  async listCallbacks(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const callbacks = await this.tasks.listCallbacksByBusiness(businessId);
    return { callbacks: callbacks.map((task) => this.publicCallback(task)) };
  }

  @Post("businesses/:businessId/callbacks")
  async createCallback(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateCallbackSchema.parse(body);
    const task = await this.tasks.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt) ?? await this.resolveAiTaskDueAt(businessId, {}),
      source: "app"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "callback",
      entityId: task.id,
      action: "CREATE_CALLBACK",
      after: task as Prisma.InputJsonValue
    });
    return { callback: this.publicCallback(task) };
  }

  @Patch("businesses/:businessId/callbacks/:callbackId")
  async updateCallback(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("callbackId") callbackId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateCallbackSchema.parse(body);
    const task = await this.tasks.update({
      businessId,
      taskId: callbackId,
      customerId: command.customerId === null ? undefined : command.customerId,
      title: command.title,
      description: command.description === null ? undefined : command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt),
      status: command.status === "DONE" ? "COMPLETED" : command.status === "OPEN" ? "OPEN" : undefined
    });
    if (!task) {
      throw new NotFoundException("Callback not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "callback",
      entityId: task.id,
      action: "UPDATE_CALLBACK",
      after: task as Prisma.InputJsonValue
    });
    return { callback: this.publicCallback(task) };
  }

  @Post("businesses/:businessId/callbacks/:callbackId/complete")
  async completeCallback(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("callbackId") callbackId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const task = await this.tasks.complete(businessId, callbackId);
    if (!task) {
      throw new NotFoundException("Callback not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "callback",
      entityId: task.id,
      action: "COMPLETE_CALLBACK",
      after: task as Prisma.InputJsonValue
    });
    return { callback: this.publicCallback(task) };
  }

  @Delete("businesses/:businessId/callbacks/:callbackId")
  async deleteCallback(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("callbackId") callbackId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const task = await this.tasks.softDelete(businessId, callbackId);
    if (!task) {
      throw new NotFoundException("Callback not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "callback",
      entityId: task.id,
      action: "DELETE_CALLBACK",
      after: task as Prisma.InputJsonValue
    });
    return { callback: this.publicCallback(task) };
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
    const duplicate = await this.customers.findDuplicateByPhone(businessId, command.phone);
    const customer = await this.customers.create({
      businessId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address
    });
    const initialNote = command.initialNote
      ? await this.customerNotes.create({ businessId, customerId: customer.id, text: command.initialNote })
      : null;
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
    return { customer, duplicateCustomer: duplicate, initialNote };
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

    const [callbacks, homeVisits, quotes, notes] = await Promise.all([
      this.tasks.listByCustomer(businessId, customerId),
      this.appointments.listByCustomer(businessId, customerId),
      this.quotes.listByCustomer(businessId, customerId),
      this.customerNotes.listByCustomer(businessId, customerId)
    ]);
    const activity = [
      ...callbacks.map((task) => this.publicCallbackWorkItem(task)),
      ...homeVisits.map((appointment) => this.publicHomeVisitWorkItem(appointment)),
      ...quotes.map((quote) => this.publicQuoteWorkItem(quote)),
      ...(notes ?? []).map((note) => ({
        id: note.id,
        type: "note",
        title: "הערה",
        description: note.text,
        dueAt: null,
        priority: "NORMAL",
        status: note.status,
        source: "note",
        customer: publicCustomer(customer),
        linkedEntity: { type: "note", id: note.id },
        actions: note.status === "DONE" ? ["open", "reopen"] : ["open", "complete"]
      }))
    ].sort((a, b) => timeOrZero(b.dueAt) - timeOrZero(a.dueAt));

    return { customer, activity };
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

  @Post("businesses/:businessId/customers/:customerId/merge")
  async mergeCustomer(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = MergeCustomerSchema.parse(body);
    const merge = await this.customers.merge({
      businessId,
      sourceCustomerId: customerId,
      targetCustomerId: command.targetCustomerId,
      mergedByUserId: user.id
    });
    if (!merge) {
      throw new NotFoundException("Customer not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: customerId,
      action: "MERGE_CUSTOMER",
      after: merge as Prisma.InputJsonValue
    });
    return { merge };
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

  @Patch("businesses/:businessId/customers/:customerId/notes/:noteId")
  async updateCustomerNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Param("noteId") noteId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateCustomerNoteSchema.parse(body);
    const note = await this.customerNotes.update({
      businessId,
      customerId,
      noteId,
      status: command.status
    });

    if (!note) {
      throw new NotFoundException("Customer note not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer_note",
      entityId: note.id,
      action: "UPDATE_CUSTOMER_NOTE",
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
    const calls = await this.incomingCalls.listByBusiness(businessId);
    return {
      calls: await Promise.all(calls.map(async (call) => {
        const transcript = call.transcripts.at(-1) ?? null;
        const relatedTask = transcript?.taskId ? await this.tasks.findByBusinessAndId(businessId, transcript.taskId) : null;
        const customer = call.fromNumber ? await this.customers.findDuplicateByPhone(businessId, call.fromNumber) : null;
        return {
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          calledAt: call.createdAt,
          durationSeconds: null,
          ivrSelection: callIvrSelection(call),
          displayStatus: relatedTask?.status === "COMPLETED" ? "TASK_COMPLETED" : callDisplayStatus(call),
          urgent: call.urgent,
          transcriptPreview: transcript?.transcript ?? null,
          relatedTask: relatedTask ? {
            id: relatedTask.id,
            status: callbackStatus(relatedTask.status),
            dueAt: relatedTask.dueAt,
            priority: relatedTask.priority
          } : null,
          customer: publicCustomer(customer)
        };
      }))
    };
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
      location: command.location,
      notes: command.notes,
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
      location: command.location,
      notes: command.notes,
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

  @Get("businesses/:businessId/home-visits")
  async listHomeVisits(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const homeVisits = await this.appointments.listByBusiness(businessId);
    return { homeVisits: homeVisits.map((appointment) => this.publicHomeVisit(appointment)) };
  }

  @Post("businesses/:businessId/home-visits")
  async createHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateHomeVisitSchema.parse(body);
    const appointment = await this.appointments.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: parseRequiredDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt) ?? new Date(parseRequiredDate(command.startsAt).getTime() + 30 * 60 * 1000)
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: appointment.id,
      action: "CREATE_HOME_VISIT",
      after: appointment as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(appointment) };
  }

  @Patch("businesses/:businessId/home-visits/:homeVisitId")
  async updateHomeVisit(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("homeVisitId") homeVisitId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateHomeVisitSchema.parse(body);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId: homeVisitId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: command.startsAt ? parseRequiredDate(command.startsAt) : undefined,
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status === "DONE" ? "COMPLETED" : command.status === "OPEN" ? "SCHEDULED" : undefined
    });
    if (!appointment) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: appointment.id,
      action: "UPDATE_HOME_VISIT",
      after: appointment as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(appointment) };
  }

  @Post("businesses/:businessId/home-visits/:homeVisitId/complete")
  async completeHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("homeVisitId") homeVisitId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId: homeVisitId,
      status: "COMPLETED"
    });
    if (!appointment) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: appointment.id,
      action: "COMPLETE_HOME_VISIT",
      after: appointment as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(appointment) };
  }

  @Delete("businesses/:businessId/home-visits/:homeVisitId")
  async deleteHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("homeVisitId") homeVisitId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.softDelete(businessId, homeVisitId);
    if (!appointment) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: appointment.id,
      action: "DELETE_HOME_VISIT",
      after: appointment as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(appointment) };
  }

  @Get("businesses/:businessId/quotes")
  async listQuotes(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const quotes = await this.quotes.listByBusiness(businessId);
    return { quotes: quotes.map((quote) => this.publicQuote(quote)) };
  }

  @Post("businesses/:businessId/quotes")
  async createQuote(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateQuoteSchema.parse(body);
    const quote = await this.quotes.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      estimatedAmount: command.estimatedAmount === undefined ? undefined : new Prisma.Decimal(command.estimatedAmount),
      dueAt: parseRequiredDate(command.dueAt),
      source: "app"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "CREATE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.publicQuote(quote) };
  }

  @Patch("businesses/:businessId/quotes/:quoteId")
  async updateQuote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("quoteId") quoteId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateQuoteSchema.parse(body);
    const quote = await this.quotes.update({
      businessId,
      quoteId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      estimatedAmount: parseOptionalAmount(command.estimatedAmount),
      dueAt: command.dueAt ? parseRequiredDate(command.dueAt) : undefined,
      status: command.status
    });
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "UPDATE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.publicQuote(quote) };
  }

  @Post("businesses/:businessId/quotes/:quoteId/mark-paid")
  async markQuotePaid(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("quoteId") quoteId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const quote = await this.quotes.markPaid(businessId, quoteId);
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "MARK_QUOTE_PAID",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.publicQuote(quote) };
  }

  @Delete("businesses/:businessId/quotes/:quoteId")
  async deleteQuote(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("quoteId") quoteId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const quote = await this.quotes.softDelete(businessId, quoteId);
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "DELETE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.publicQuote(quote) };
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

  @Post("businesses/:businessId/notifications/:notificationId/read")
  async markNotificationRead(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("notificationId") notificationId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/notifications/read-all")
  async markAllNotificationsRead(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/notifications/:notificationId/snooze")
  async snoozeNotification(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("notificationId") notificationId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = SnoozeNotificationSchema.parse(body);
    const notification = await this.notifications.findByBusinessAndId(businessId, notificationId);
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    const settings = await this.settings.getByBusiness(businessId);
    const dueAt = snoozeDueAt(command.preset, settings.timezone);
    const itemType = notification.itemType ?? (notification.taskId ? "callback" : null);
    const itemId = notification.itemId ?? notification.taskId;
    if (!itemType || !itemId) {
      throw new BadRequestException("Notification is not linked to a snoozable item");
    }

    let item: unknown;
    if (itemType === "callback") {
      item = await this.tasks.snooze(businessId, itemId, dueAt);
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

  @Get("businesses/:businessId/pending-actions")
  async listPendingActions(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = ListByStatusQuerySchema.parse(query);
    return { pendingActions: await this.pendingActions.listByBusinessAndStatus(businessId, command.status) };
  }

  @Get("businesses/:businessId/ai-pending-actions")
  async listAiPendingActions(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    return this.listPendingActions(headers, businessId, query);
  }

  @Patch("businesses/:businessId/ai-pending-actions/:pendingActionId")
  async updateAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("pendingActionId") pendingActionId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdatePendingActionSchema.parse(body);
    const pendingAction = await this.pendingActions.update({
      businessId,
      pendingActionId,
      payload: command.payload as Prisma.InputJsonValue | undefined,
      missingFields: command.missingFields,
      reviewReason: command.reviewReason
    });
    if (!pendingAction) {
      throw new NotFoundException("Pending action not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "pending_action",
      entityId: pendingAction.id,
      action: "UPDATE_PENDING_ACTION",
      after: pendingAction as Prisma.InputJsonValue
    });
    return { pendingAction };
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

  @Post("businesses/:businessId/ai-pending-actions/:pendingActionId/reject")
  async rejectAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("pendingActionId") pendingActionId: string
  ) {
    return this.rejectPendingAction(headers, businessId, pendingActionId);
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

  @Post("businesses/:businessId/ai-pending-actions/:pendingActionId/approve")
  async approveAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("pendingActionId") pendingActionId: string,
    @Body() body: unknown
  ) {
    return this.completePendingAction(headers, businessId, pendingActionId, body);
  }

  @Get("businesses/:businessId/audit-events")
  async listAuditEvents(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    return { auditEvents: await this.audit.listByBusiness(businessId) };
  }

  private publicCallback(task: {
    id: string;
    customerId?: string | null;
    title: string;
    description?: string | null;
    priority: string;
    dueAt?: Date | null;
    status: string;
    source: string;
    sourceRef?: string | null;
    createdAt: Date;
    updatedAt: Date;
    customer?: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null } | null;
  }) {
    return {
      id: task.id,
      customerId: task.customerId ?? null,
      title: task.title,
      description: task.description ?? null,
      priority: task.priority,
      dueAt: task.dueAt ?? null,
      status: callbackStatus(task.status),
      source: task.source,
      sourceRef: task.sourceRef ?? null,
      customer: publicCustomer(task.customer),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
  }

  private publicCallbackWorkItem(task: Parameters<CoreController["publicCallback"]>[0]) {
    const callback = this.publicCallback(task);
    return {
      id: callback.id,
      type: "callback",
      title: callback.title,
      description: callback.description,
      customer: callback.customer,
      dueAt: callback.dueAt ?? callback.createdAt,
      priority: callback.priority,
      status: callback.status,
      source: callback.source,
      linkedEntity: { type: "callback", id: callback.id },
      actions: callback.status === "DONE" ? ["open"] : ["call", "complete", "open"]
    };
  }

  private publicHomeVisit(appointment: {
    id: string;
    customerId?: string | null;
    title: string;
    location?: string | null;
    notes?: string | null;
    startsAt: Date;
    endsAt?: Date | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    customer?: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null } | null;
  }) {
    return {
      id: appointment.id,
      customerId: appointment.customerId ?? null,
      title: appointment.title,
      location: appointment.location ?? null,
      notes: appointment.notes ?? null,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt ?? null,
      status: homeVisitStatus(appointment.status),
      customer: publicCustomer(appointment.customer),
      createdAt: appointment.createdAt,
      updatedAt: appointment.updatedAt
    };
  }

  private publicHomeVisitWorkItem(appointment: Parameters<CoreController["publicHomeVisit"]>[0]) {
    const homeVisit = this.publicHomeVisit(appointment);
    return {
      id: homeVisit.id,
      type: "home_visit",
      title: homeVisit.title,
      description: homeVisit.notes ?? homeVisit.location,
      customer: homeVisit.customer,
      dueAt: homeVisit.startsAt,
      priority: "NORMAL",
      status: homeVisit.status,
      source: "app",
      linkedEntity: { type: "home_visit", id: homeVisit.id },
      actions: homeVisit.status === "DONE" ? ["open"] : ["navigate", "complete", "open"]
    };
  }

  private publicQuote(quote: {
    id: string;
    customerId?: string | null;
    title: string;
    description?: string | null;
    estimatedAmount?: Prisma.Decimal | null;
    dueAt: Date;
    status: string;
    source: string;
    sourceRef?: string | null;
    createdAt: Date;
    updatedAt: Date;
    customer?: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null } | null;
  }) {
    return {
      id: quote.id,
      customerId: quote.customerId ?? null,
      title: quote.title,
      description: quote.description ?? null,
      estimatedAmount: quote.estimatedAmount?.toString() ?? null,
      dueAt: quote.dueAt,
      status: quote.status,
      source: quote.source,
      sourceRef: quote.sourceRef ?? null,
      customer: publicCustomer(quote.customer),
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt
    };
  }

  private publicQuoteWorkItem(quote: Parameters<CoreController["publicQuote"]>[0]) {
    const publicQuote = this.publicQuote(quote);
    return {
      id: publicQuote.id,
      type: "quote",
      title: publicQuote.title,
      description: publicQuote.description,
      customer: publicQuote.customer,
      dueAt: publicQuote.dueAt,
      priority: "NORMAL",
      status: publicQuote.status,
      source: publicQuote.source,
      linkedEntity: { type: "quote", id: publicQuote.id },
      actions: publicQuote.status === "PAID" ? ["open"] : ["open", "edit", "mark_paid"]
    };
  }

  private async executeStructuredAction(input: {
    businessId: string;
    userId: string;
    actionType: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    if (input.actionType === "CREATE_TASK" || input.actionType === "CREATE_CALLBACK") {
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

    if (input.actionType === "COMPLETE_TASK" || input.actionType === "COMPLETE_CALLBACK") {
      const taskId = typeof input.payload.taskId === "string" ? input.payload.taskId
        : typeof input.payload.callbackId === "string" ? input.payload.callbackId
          : undefined;
      if (!taskId) {
        throw new BadRequestException("Action payload is missing callbackId");
      }
      const task = await this.tasks.complete(input.businessId, taskId);
      if (!task) {
        throw new NotFoundException("Callback not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "structured_action",
        entityType: "callback",
        entityId: task.id,
        action: "COMPLETE_CALLBACK_FROM_ACTION",
        after: task as Prisma.InputJsonValue
      });
      return { type: input.actionType, task };
    }

    if (input.actionType === "UPDATE_TASK" || input.actionType === "UPDATE_CALLBACK") {
      const taskId = typeof input.payload.taskId === "string" ? input.payload.taskId
        : typeof input.payload.callbackId === "string" ? input.payload.callbackId
          : undefined;
      if (!taskId) {
        throw new BadRequestException("Action payload is missing callbackId");
      }
      const task = await this.tasks.update({
        businessId: input.businessId,
        taskId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : input.payload.priority === "NORMAL" ? "NORMAL" : undefined,
        dueAt: typeof input.payload.dueAt === "string" ? await this.resolveAiTaskDueAt(input.businessId, input.payload) : undefined,
        status: input.payload.status === "DONE" || input.payload.status === "COMPLETED" ? "COMPLETED" : undefined
      });
      if (!task) {
        throw new NotFoundException("Callback not found");
      }
      return { type: input.actionType, task };
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

    if (input.actionType === "UPDATE_CUSTOMER") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      if (!customerId) {
        throw new BadRequestException("Action payload is missing customerId");
      }
      const customer = await this.customers.update({
        businessId: input.businessId,
        customerId,
        name: typeof input.payload.name === "string" ? input.payload.name : undefined,
        phone: typeof input.payload.phone === "string" ? input.payload.phone : undefined,
        email: typeof input.payload.email === "string" ? input.payload.email : undefined,
        address: typeof input.payload.address === "string" ? input.payload.address : undefined
      });
      if (!customer) {
        throw new NotFoundException("Customer not found");
      }
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

    if (input.actionType === "CREATE_APPOINTMENT" || input.actionType === "CREATE_HOME_VISIT") {
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      const startsAt = typeof input.payload.startsAt === "string" ? input.payload.startsAt
        : typeof input.payload.dueAt === "string" ? input.payload.dueAt
          : undefined;
      if (!title || !startsAt) {
        throw new BadRequestException("Pending action payload is missing appointment title or startsAt");
      }
      const appointment = await this.appointments.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
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

    if (input.actionType === "UPDATE_APPOINTMENT" || input.actionType === "UPDATE_HOME_VISIT") {
      const appointmentId = typeof input.payload.appointmentId === "string" ? input.payload.appointmentId
        : typeof input.payload.homeVisitId === "string" ? input.payload.homeVisitId
          : undefined;
      if (!appointmentId) {
        throw new BadRequestException("Action payload is missing homeVisitId");
      }
      const appointment = await this.appointments.update({
        businessId: input.businessId,
        appointmentId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
        startsAt: typeof input.payload.startsAt === "string" ? parseRequiredDate(input.payload.startsAt) : undefined,
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined,
        status: input.payload.status === "DONE" || input.payload.status === "COMPLETED" ? "COMPLETED" : undefined
      });
      if (!appointment) {
        throw new NotFoundException("Home visit not found");
      }
      return { type: input.actionType, appointment };
    }

    if (input.actionType === "CREATE_QUOTE") {
      const existing = await this.quotes.findByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) {
        return { type: input.actionType, duplicate: true, quote: existing };
      }
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!title) {
        throw new BadRequestException("Action payload is missing quote title");
      }
      const quote = await this.quotes.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        estimatedAmount: typeof input.payload.estimatedAmount === "string" || typeof input.payload.estimatedAmount === "number"
          ? new Prisma.Decimal(input.payload.estimatedAmount)
          : undefined,
        dueAt: await this.resolveAiTaskDueAt(input.businessId, input.payload),
        source: "structured_action",
        sourceRef: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "structured_action",
        entityType: "quote",
        entityId: quote.id,
        action: "CREATE_QUOTE_FROM_ACTION",
        after: quote as Prisma.InputJsonValue
      });
      return { type: input.actionType, duplicate: false, quote };
    }

    if (input.actionType === "MARK_QUOTE_PAID") {
      const quoteId = typeof input.payload.quoteId === "string" ? input.payload.quoteId : undefined;
      if (!quoteId) {
        throw new BadRequestException("Action payload is missing quoteId");
      }
      const quote = await this.quotes.markPaid(input.businessId, quoteId);
      if (!quote) {
        throw new NotFoundException("Quote not found");
      }
      return { type: input.actionType, quote };
    }

    if (input.actionType === "UPDATE_QUOTE") {
      const quoteId = typeof input.payload.quoteId === "string" ? input.payload.quoteId : undefined;
      if (!quoteId) {
        throw new BadRequestException("Action payload is missing quoteId");
      }
      const quote = await this.quotes.update({
        businessId: input.businessId,
        quoteId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        estimatedAmount: typeof input.payload.estimatedAmount === "string" || typeof input.payload.estimatedAmount === "number"
          ? new Prisma.Decimal(input.payload.estimatedAmount)
          : undefined,
        dueAt: typeof input.payload.dueAt === "string" ? await this.resolveAiTaskDueAt(input.businessId, input.payload) : undefined,
        status: input.payload.status === "PAID" ? "PAID" : input.payload.status === "OPEN" ? "OPEN" : undefined
      });
      if (!quote) {
        throw new NotFoundException("Quote not found");
      }
      return { type: input.actionType, quote };
    }

    if (input.actionType === "MERGE_CUSTOMERS") {
      const sourceCustomerId = typeof input.payload.sourceCustomerId === "string" ? input.payload.sourceCustomerId : undefined;
      const targetCustomerId = typeof input.payload.targetCustomerId === "string" ? input.payload.targetCustomerId : undefined;
      if (!sourceCustomerId || !targetCustomerId) {
        throw new BadRequestException("Action payload is missing sourceCustomerId or targetCustomerId");
      }
      const merge = await this.customers.merge({
        businessId: input.businessId,
        sourceCustomerId,
        targetCustomerId,
        mergedByUserId: input.userId
      });
      if (!merge) {
        throw new NotFoundException("Customer not found");
      }
      return { type: input.actionType, merge };
    }

    if (input.actionType === "DELETE_TREATMENT_ITEM") {
      const itemType = typeof input.payload.itemType === "string" ? input.payload.itemType : undefined;
      const itemId = typeof input.payload.itemId === "string" ? input.payload.itemId : undefined;
      if (!itemType || !itemId) {
        throw new BadRequestException("Action payload is missing itemType or itemId");
      }
      if (itemType === "callback") {
        return { type: input.actionType, item: await this.tasks.softDelete(input.businessId, itemId) };
      }
      if (itemType === "home_visit") {
        return { type: input.actionType, item: await this.appointments.softDelete(input.businessId, itemId) };
      }
      if (itemType === "quote") {
        return { type: input.actionType, item: await this.quotes.softDelete(input.businessId, itemId) };
      }
      throw new BadRequestException("Unsupported treatment item type");
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

  private isInvalidOwnerVoiceTranscript(transcript: string): boolean {
    const normalized = transcript.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
    const visibleCharacters = normalized.replace(/\s+/g, "");
    return visibleCharacters.length < 2 ||
      normalized === "הקלטה של בעל עסק בעברית שמבקש ליצור משימה, לקוח, פגישה, עבודה או הערה במערכת CRM.";
  }

  private async executeVoiceCommandActions(input: {
    businessId: string;
    userId: string;
    transcript: string;
    actions: AiAction[];
  }) {
    const results = [];
    const createdCustomers: Array<{ id: string; name?: string | null; phone?: string | null }> = [];
    const settings = await this.settings.getByBusiness(input.businessId);

    for (const action of input.actions) {
      let payload = this.resolveVoiceActionPayload(action.payload, createdCustomers);
      payload = this.enrichVoiceActionPayload(action, payload, input.transcript, settings.timezone);
      payload = await this.resolveVoiceActionReferences({
        businessId: input.businessId,
        actionType: action.type,
        payload,
        transcript: input.transcript
      });
      const missingFields = this.requiredVoiceMissingFields(action, payload);
      const requiresConfirmation = action.requiresConfirmation && (action.missingFields.length === 0 || missingFields.length > 0);
      if (missingFields.length > 0 || requiresConfirmation) {
        const pending = await this.pendingActions.create({
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

    if (this.voiceActionNeedsTask(input.actionType, payload)) {
      const task = await this.resolveVoiceTask(input.businessId, payload, input.transcript);
      if (task) {
        payload = { ...payload, taskId: task.id, callbackId: task.id };
      }
    }

    return payload;
  }

  private voiceActionNeedsCustomer(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.customerId === "string") {
      return false;
    }
    return actionType === "UPDATE_CUSTOMER" ||
      actionType === "ADD_CUSTOMER_NOTE" ||
      actionType === "CREATE_TASK" ||
      actionType === "CREATE_CALLBACK" ||
      actionType === "CREATE_HOME_VISIT" ||
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "COMPLETE_TASK" ||
      actionType === "COMPLETE_CALLBACK";
  }

  private voiceActionNeedsTask(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.taskId === "string" || typeof payload.callbackId === "string") {
      return false;
    }
    return actionType === "COMPLETE_TASK" || actionType === "COMPLETE_CALLBACK";
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

  private async resolveVoiceTask(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    const title = this.normalizedVoiceText(payload.title);
    const text = this.normalizedVoiceText(payload.text);
    const lookupText = this.normalizedVoiceText([title, text, transcript].filter(Boolean).join(" "));

    const tasks = await this.prisma.task.findMany({
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

    if (tasks.length === 1) {
      return tasks[0];
    }

    const matchingTasks = tasks.filter((task) => {
      const normalizedTitle = this.normalizedVoiceText(task.title);
      const haystack = this.normalizedVoiceText([
        task.title,
        task.description,
        task.customer?.name,
        task.customer?.phone
      ].filter(Boolean).join(" "));
      return Boolean(lookupText && haystack && (
        lookupText.includes(haystack) ||
        haystack.includes(lookupText) ||
        normalizedTitle && lookupText.includes(normalizedTitle)
      ));
    });

    return matchingTasks.length === 1 ? matchingTasks[0] : null;
  }

  private normalizedVoiceText(value: unknown) {
    return typeof value === "string" ? value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : undefined;
  }

  private enrichVoiceActionPayload(action: AiAction, payload: Record<string, unknown>, transcript: string, timeZone: string) {
    if ((action.type === "CREATE_TASK" || action.type === "CREATE_CALLBACK") && typeof payload.dueAt !== "string") {
      const dueAt = parseHebrewVoiceDueAt(transcript, timeZone);
      if (dueAt) {
        return { ...payload, dueAt: dueAt.toISOString() };
      }
    }
    return payload;
  }

  private requiredVoiceMissingFields(action: AiAction, payload: Record<string, unknown>) {
    return action.missingFields.filter((field) => !this.isOptionalVoiceField(action.type, field) && payload[field] === undefined);
  }

  private isOptionalVoiceField(actionType: string, field: string) {
    if (field === "dueAt") {
      return actionType === "CREATE_TASK" || actionType === "CREATE_CALLBACK";
    }

    if (field === "phone") {
      return actionType === "CREATE_CUSTOMER" ||
        actionType === "CREATE_TASK" ||
        actionType === "CREATE_CALLBACK";
    }

    return false;
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
      dueAt: await this.resolveAiTaskDueAt(command.businessId, {}),
      source: "telephony",
      sourceRef: command.sourceCallId,
      idempotencyKey: command.idempotencyKey
    });

    const notification = await this.notifications.create({
      businessId: command.businessId,
      taskId: task.id,
      itemType: "callback",
      itemId: task.id,
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
    const { firebaseUid, phoneNumber } = await this.verifyAuth(headers);
    const user = await this.auth.getMe(firebaseUid, phoneNumber);
    if (!user) {
      throw new UnauthorizedException("Authenticated user was not found");
    }
    return user;
  }

  private async requireBusinessAccess(headers: RequestHeaders, businessId: string): Promise<AuthenticatedUser> {
    const user = await this.requireAuthenticatedUser(headers);
    const hasMembership = user.memberships?.some((membership) => membership.businessId === businessId && membership.status === "ACTIVE");
    if (user.businessId !== businessId && !hasMembership) {
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

  private async verifyAuth(headers: RequestHeaders, options?: { mockFallback?: string }): Promise<VerifiedAuth> {
    if (authProviderName() === "firebase") {
      const token = parseBearerToken(headers);
      try {
        firebaseApp();
        const decoded = await getAuth().verifyIdToken(token);
        return {
          firebaseUid: decoded.uid,
          email: decoded.email,
          phoneNumber: typeof decoded.phone_number === "string" ? decoded.phone_number : undefined,
          displayName: displayNameFromToken(decoded)
        };
      } catch {
        throw new UnauthorizedException("Missing or invalid Firebase ID token");
      }
    }

    return {
      firebaseUid: options?.mockFallback ?? parseMockFirebaseUid(headers),
      phoneNumber: headerValue(headers, "x-mock-phone-number")
    };
  }
}

@Module({
  controllers: [CoreController],
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
    TasksRepository,
    CustomerNotesRepository,
    AppointmentsRepository,
    QuotesRepository,
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
