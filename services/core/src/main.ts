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
import { ApiExceptionFilter, cloudRunServiceAuthHeaders, getEnv, getInternalApiSecret, getPort, health, log, stableIdempotencyKey, verifyGoogleOidcToken } from "@myclient/common";
import {
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
  ListByStatusQuerySchema,
  MergeCustomerSchema,
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

type VoiceCommandExecutionResult = {
  status: string;
  results: Array<Record<string, unknown>>;
};

function formatCaller(callerPhone: string | undefined): string {
  return callerPhone ?? "מספר לא מזוהה";
}

function buildReminderFromCallDescription(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `מתקשר: ${caller}\nהודעה: ${transcript}`;
  }

  return `מתקשר: ${caller}\nהלקוח ביקש שתחזור אליו.`;
}

function buildReminderNotificationBody(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `${caller}: ${transcript}`;
  }

  return `${caller} ביקש שתחזור אליו.`;
}

function buildReminderReminderBody(reminder: { title: string; description?: string | null }) {
  return reminder.description ? `${reminder.title}\n${reminder.description}` : reminder.title;
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

function scheduledTimeOrZero(item: { dueAt?: Date | string | null; startsAt?: Date | string | null }) {
  return timeOrZero(item.dueAt ?? item.startsAt);
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

function defaultAiReminderDueAt(timeZone: string, now = new Date()) {
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

function tryParseAiDueAt(value: string, timeZone: string) {
  try {
    return parseAiDueAt(value, timeZone);
  } catch {
    return undefined;
  }
}

function parseHebrewVoiceDueAt(text: string, timeZone: string, now = new Date()) {
  const relativeDueAt = parseHebrewRelativeDueAt(text, now);
  if (relativeDueAt) {
    return relativeDueAt;
  }

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

function parseHebrewRelativeDueAt(text: string, now = new Date()) {
  if (/(?:בעוד|עוד)\s+רבע\s+שעה/.test(text)) {
    return new Date(now.getTime() + 15 * 60 * 1000);
  }
  if (/(?:בעוד|עוד)\s+חצי\s+שעה/.test(text)) {
    return new Date(now.getTime() + 30 * 60 * 1000);
  }
  if (/(?:בעוד|עוד)\s+שעה/.test(text)) {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }

  const relativeMatch = text.match(/(?:בעוד|עוד)\s+([0-9]{1,3}|אחת|אחד|שתיים|שניים|שתים|שתי|שני|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|עשרים|שלושים|ארבעים|חמישים|שישים)\s+(דקות?|שעות?|רבע שעה|חצי שעה)/);
  if (!relativeMatch) {
    return undefined;
  }

  const amount = parseHebrewNumber(relativeMatch[1]);
  if (amount === undefined || amount <= 0) {
    return undefined;
  }

  const unit = relativeMatch[2];
  const minutes = unit.includes("שעה") && !unit.includes("רבע") && !unit.includes("חצי")
    ? amount * 60
    : unit.includes("חצי")
      ? 30
      : unit.includes("רבע")
        ? 15
        : amount;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

function parseHebrewNumber(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return {
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
    "עשרים": 20,
    "שלושים": 30,
    "ארבעים": 40,
    "חמישים": 50,
    "שישים": 60
  }[value];
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

function parseOptionalBearerToken(headers: RequestHeaders): string | undefined {
  const authorization = headerValue(headers, "authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return undefined;
  }

  const token = authorization.slice(prefix.length).trim();
  return token || undefined;
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

function publicCustomer(customer: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null; createdAt?: Date } | null | undefined) {
  if (!customer) {
    return null;
  }
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    address: customer.address ?? null,
    createdAt: customer.createdAt ?? null
  };
}

function decodePageCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.id !== "string" || typeof decoded.createdAt !== "string") {
      throw new Error("Invalid cursor shape");
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("Invalid cursor date");
    }
    return { createdAt, id: decoded.id };
  } catch {
    throw new BadRequestException("Invalid pagination cursor");
  }
}

function encodePageCursor(item: { id: string; createdAt: Date }): string {
  return Buffer.from(JSON.stringify({
    createdAt: item.createdAt.toISOString(),
    id: item.id
  })).toString("base64url");
}

function paginatedResponse<T extends { id: string; createdAt: Date }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  return {
    items: pageItems,
    pageInfo: {
      hasMore,
      nextCursor: hasMore && pageItems.length > 0 ? encodePageCursor(pageItems[pageItems.length - 1]) : null
    }
  };
}

function paginationFromQuery(query: unknown) {
  return paginationFromParsedQuery(PaginationQuerySchema.parse(query));
}

function paginationFromParsedQuery(command: { limit: number; cursor?: string }) {
  return {
    limit: command.limit,
    cursor: decodePageCursor(command.cursor)
  };
}

function reminderStatus(status: string) {
  return status;
}

function homeVisitStatus(status: string) {
  return status;
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

function callDisplayStatus(call: { selectedDigit?: string | null; transcripts?: Array<{ reminderId?: string | null }> }) {
  if (call.transcripts?.some((transcript) => transcript.reminderId)) {
    return "REMINDER_CREATED";
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
    android: {
      priority: "high",
      notification: {
        channelId: "reminder_reminders"
      }
    },
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

  @Post("internal/reminders/from-call")
  async createReminderFromCall(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    this.requireInternalSecret(headers);
    const command = CreateReminderFromCallSchema.parse(body);
    return this.executeReminderFromCall(command);
  }

  @Post("internal/reminders/due")
  async processDueReminders(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    await this.requireInternalScheduler(headers);
    const requestedLimit = Number((body as { limit?: unknown })?.limit ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const dueReminders = await this.reminders.listDueReminders(limit);
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
      const notificationDelivery = await this.sendNotification(notification);
      const updatedReminder = await this.reminders.markReminderSent(reminder.id);
      await this.audit.record({
        businessId: reminder.businessId,
        actorType: "system",
        source: "worker",
        entityType: "reminder",
        entityId: reminder.id,
        action: "SEND_REMINDER_NOTIFICATION",
        after: updatedReminder as Prisma.InputJsonValue,
        result: notificationDelivery.status
      });
      processedReminders.push({
        reminder: updatedReminder,
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

  @Post("owner-actions/execute")
  async executeOwnerAction(@Headers() headers: RequestHeaders, @Body() body: unknown) {
    const request = body as { businessId?: string; action?: unknown };
    if (!request.businessId) {
      throw new BadRequestException("businessId is required");
    }

    const user = await this.requireBusinessAccess(headers, request.businessId);
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

  @Get("businesses/:businessId/voice-commands")
  async listOwnerVoiceCommands(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.ownerVoiceCommands.listByBusiness(businessId, pagination), pagination.limit);
    return { voiceCommands: page.items, pageInfo: page.pageInfo };
  }

  @Post("businesses/:businessId/voice-commands/realtime-session")
  async createOwnerVoiceRealtimeSession(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/voice-commands/transcript")
  async createOwnerVoiceCommandFromTranscript(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
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
        voiceResult: this.voiceResultFromStoredCommand(existing)
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: transcriptBody.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      if (this.isInvalidOwnerVoiceTranscript(transcriptBody.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: transcriptBody.transcript,
        sttProvider: transcriptBody.sttProvider,
        sttConfidence: transcriptBody.sttConfidence ?? undefined,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.parseOwnerCommandIntent({
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
      const voiceResult = this.buildVoiceCommandResult({
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
      const voiceResult = this.buildFailedVoiceCommandResult({
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
    const existing = await this.ownerVoiceCommands.findByBusinessAndIdempotencyKey(businessId, commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult,
        voiceResult: this.voiceResultFromStoredCommand(existing)
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
      const settings = await this.settings.getByBusiness(businessId);
      const voiceResult = this.buildVoiceCommandResult({
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
      const voiceResult = this.buildFailedVoiceCommandResult({
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

  @Get("businesses/:businessId/home")
  async getHome(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = HomeQuerySchema.parse(query);
    const settings = await this.settings.getByBusiness(businessId);
    const start = startOfLocalDate(command.date, settings.timezone);
    const end = addUtcDays(start, 1);
    const includeOpenBeforeStart = isSameUtcInstant(start, startOfLocalDate(undefined, settings.timezone));
    const [reminders, homeVisits, appointments, quotes, notifications] = await Promise.all([
      command.filter === "home_visits" || command.filter === "appointments" || command.filter === "quotes" || command.filter === "calls"
        ? Promise.resolve([])
        : this.reminders.listRemindersForDate({ businessId, start, end, search: command.search, urgentOnly: command.filter === "urgent", includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "appointments" || command.filter === "quotes" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.homeVisits.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "home_visits" || command.filter === "quotes" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.appointments.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "home_visits" || command.filter === "appointments" || command.filter === "calls" || command.filter === "urgent"
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
          type: notification.itemType ?? (notification.reminderId ? "reminder" : "notification"),
          id: notification.itemId ?? notification.reminderId ?? notification.id
        },
        actions: ["open", "mark_read"]
      }));

    const items = [
      ...reminders.map((reminder) => this.publicReminderWorkItem(reminder)),
      ...homeVisits.map((homeVisit) => this.publicHomeVisitWorkItem(homeVisit)),
      ...appointments.map((appointment) => this.publicAppointmentWorkItem(appointment)),
      ...quotes.map((quote) => this.publicQuoteWorkItem(quote)),
      ...notificationItems
    ].sort((a, b) => {
      const priority = Number(b.priority === "URGENT") - Number(a.priority === "URGENT");
      if (priority !== 0) return priority;
      return scheduledTimeOrZero(a) - scheduledTimeOrZero(b);
    });

    return {
      date: command.date ?? start.toISOString().slice(0, 10),
      filter: command.filter,
      items
    };
  }

  @Get("businesses/:businessId/reminders")
  async listReminders(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const reminders = await this.reminders.listRemindersByBusiness(businessId);
    return { reminders: reminders.map((reminder) => this.publicReminder(reminder)) };
  }

  @Post("businesses/:businessId/reminders")
  async createReminder(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateReminderSchema.parse(body);
    const reminder = await this.reminders.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt) ?? await this.resolveAiReminderDueAt(businessId, {}),
      status: command.status,
      source: "app"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "CREATE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.publicReminder(reminder) };
  }

  @Patch("businesses/:businessId/reminders/:reminderId")
  async updateReminder(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("reminderId") reminderId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateReminderSchema.parse(body);
    const reminder = await this.reminders.update({
      businessId,
      reminderId: reminderId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt),
      status: command.status
    });
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "UPDATE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.publicReminder(reminder) };
  }

  @Post("businesses/:businessId/reminders/:reminderId/complete")
  async completeReminder(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("reminderId") reminderId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const reminder = await this.reminders.complete(businessId, reminderId);
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "COMPLETE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.publicReminder(reminder) };
  }

  @Delete("businesses/:businessId/reminders/:reminderId")
  async deleteReminder(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("reminderId") reminderId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const reminder = await this.reminders.softDelete(businessId, reminderId);
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "DELETE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.publicReminder(reminder) };
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
      ? await this.notes.create({ businessId, customerId: customer.id, text: command.initialNote })
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
  async listCustomers(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.customers.listByBusiness(businessId, pagination), pagination.limit);
    return { customers: page.items, pageInfo: page.pageInfo };
  }

  @Get("businesses/:businessId/customers/:customerId")
  async getCustomer(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("customerId") customerId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const customer = await this.customers.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new NotFoundException("Customer not found");
    }

    const [reminders, homeVisits, quotes, notes] = await Promise.all([
      this.reminders.listByCustomer(businessId, customerId),
      this.homeVisits.listByCustomer(businessId, customerId),
      this.quotes.listByCustomer(businessId, customerId),
      this.notes.listByCustomer(businessId, customerId)
    ]);
    const activity = [
      ...reminders.map((reminder) => this.publicReminderWorkItem(reminder)),
      ...homeVisits.map((homeVisit) => this.publicHomeVisitWorkItem(homeVisit)),
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
    ].sort((a, b) => scheduledTimeOrZero(b) - scheduledTimeOrZero(a));

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

  @Delete("businesses/:businessId/customers/:customerId")
  async deleteCustomer(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const deletion = await this.customers.softDelete({ businessId, customerId });
    if (!deletion) {
      throw new NotFoundException("Customer not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: deletion.customer.id,
      action: "DELETE_CUSTOMER",
      after: deletion as Prisma.InputJsonValue
    });
    return { customer: deletion.customer, deleted: deletion.deleted };
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
      mergedByUserId: user.id,
      fieldChoices: command.fieldChoices
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
  async createNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateNoteSchema.parse(body);
    const note = await this.notes.create({
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
  async updateNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Param("noteId") noteId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = UpdateNoteSchema.parse(body);
    const note = await this.notes.update({
      businessId,
      customerId,
      noteId,
      text: command.text,
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

  @Delete("businesses/:businessId/customers/:customerId/notes/:noteId")
  async deleteNote(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("customerId") customerId: string,
    @Param("noteId") noteId: string
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const note = await this.notes.softDelete(businessId, noteId, customerId);
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
      action: "DELETE_CUSTOMER_NOTE",
      after: note as Prisma.InputJsonValue
    });
    return { note };
  }

  @Get("businesses/:businessId/customers/:customerId/notes")
  async listNotes(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("customerId") customerId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const notes = await this.notes.listByCustomer(businessId, customerId);
    if (!notes) {
      throw new NotFoundException("Customer not found");
    }

    return { notes };
  }

  @Get("businesses/:businessId/calls")
  async listIncomingCalls(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const callsPage = paginatedResponse(await this.incomingCalls.listByBusiness(businessId, pagination), pagination.limit);
    return {
      calls: await Promise.all(callsPage.items.map(async (call) => {
        const transcript = call.transcripts.at(-1) ?? null;
        const relatedReminder = transcript?.reminderId ? await this.reminders.findByBusinessAndId(businessId, transcript.reminderId) : null;
        const customer = call.fromNumber ? await this.customers.findDuplicateByPhone(businessId, call.fromNumber) : null;
        return {
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          calledAt: call.createdAt,
          durationSeconds: null,
          ivrSelection: callIvrSelection(call),
          displayStatus: relatedReminder?.status === "DONE" ? "REMINDER_DONE" : callDisplayStatus(call),
          urgent: call.urgent,
          transcriptPreview: transcript?.transcript ?? null,
          relatedReminder: relatedReminder ? {
            id: relatedReminder.id,
            status: reminderStatus(relatedReminder.status),
            dueAt: relatedReminder.dueAt,
            priority: relatedReminder.priority
          } : null,
          customer: publicCustomer(customer)
        };
      })),
      pageInfo: callsPage.pageInfo
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
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
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

  @Delete("businesses/:businessId/appointments/:appointmentId")
  async deleteAppointment(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("appointmentId") appointmentId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.softDelete(businessId, appointmentId);
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
      action: "DELETE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  @Get("businesses/:businessId/home-visits")
  async listHomeVisits(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string) {
    await this.requireBusinessAccess(headers, businessId);
    const homeVisits = await this.homeVisits.listByBusiness(businessId);
    return { homeVisits: homeVisits.map((homeVisit) => this.publicHomeVisit(homeVisit)) };
  }

  @Post("businesses/:businessId/home-visits")
  async createHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Body() body: unknown) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const command = CreateHomeVisitSchema.parse(body);
    const homeVisit = await this.homeVisits.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: parseRequiredDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt) ?? new Date(parseRequiredDate(command.startsAt).getTime() + 30 * 60 * 1000),
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "CREATE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(homeVisit) };
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
    const homeVisit = await this.homeVisits.update({
      businessId,
      homeVisitId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: command.startsAt ? parseRequiredDate(command.startsAt) : undefined,
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
    });
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "UPDATE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(homeVisit) };
  }

  @Post("businesses/:businessId/home-visits/:homeVisitId/complete")
  async completeHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("homeVisitId") homeVisitId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const homeVisit = await this.homeVisits.complete(businessId, homeVisitId);
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "COMPLETE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(homeVisit) };
  }

  @Delete("businesses/:businessId/home-visits/:homeVisitId")
  async deleteHomeVisit(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Param("homeVisitId") homeVisitId: string) {
    const user = await this.requireBusinessAccess(headers, businessId);
    const homeVisit = await this.homeVisits.softDelete(businessId, homeVisitId);
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "DELETE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.publicHomeVisit(homeVisit) };
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
      status: command.status,
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
      status: "DONE"
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

  @Get("businesses/:businessId/notifications")
  async listNotifications(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = ListByStatusQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(await this.notifications.listByBusinessAndStatus(businessId, command.status, pagination), pagination.limit);
    return { notifications: page.items, pageInfo: page.pageInfo };
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

  @Get("businesses/:businessId/ai-pending-actions")
  async listAiPendingActions(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const command = ListByStatusQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(await this.aiPendingActions.listByBusinessAndStatus(businessId, command.status, pagination), pagination.limit);
    return { aiPendingActions: page.items, pageInfo: page.pageInfo };
  }

  @Patch("businesses/:businessId/ai-pending-actions/:aiPendingActionId")
  async updateAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("aiPendingActionId") aiPendingActionId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/ai-pending-actions/:aiPendingActionId/reject")
  async rejectAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("aiPendingActionId") aiPendingActionId: string
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
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

  @Post("businesses/:businessId/ai-pending-actions/:aiPendingActionId/approve")
  async approveAiPendingAction(
    @Headers() headers: RequestHeaders,
    @Param("businessId") businessId: string,
    @Param("aiPendingActionId") aiPendingActionId: string,
    @Body() body: unknown
  ) {
    const user = await this.requireBusinessAccess(headers, businessId);
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
      const execution = await this.executeStructuredAction({
        businessId,
        userId: user.id,
        actionType: claimed.actionType,
        payload,
        idempotencyKey: stableIdempotencyKey("ai_pending_action", claimed.id)
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

  @Get("businesses/:businessId/audit-events")
  async listAuditEvents(@Headers() headers: RequestHeaders, @Param("businessId") businessId: string, @Query() query: unknown) {
    await this.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.audit.listByBusiness(businessId, pagination), pagination.limit);
    return { auditEvents: page.items, pageInfo: page.pageInfo };
  }

  private publicReminder(reminder: {
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
      id: reminder.id,
      customerId: reminder.customerId ?? null,
      title: reminder.title,
      description: reminder.description ?? null,
      priority: reminder.priority,
      dueAt: reminder.dueAt ?? null,
      status: reminderStatus(reminder.status),
      source: reminder.source,
      sourceRef: reminder.sourceRef ?? null,
      customer: publicCustomer(reminder.customer),
      createdAt: reminder.createdAt,
      updatedAt: reminder.updatedAt
    };
  }

  private publicReminderWorkItem(rawReminder: Parameters<CoreController["publicReminder"]>[0]) {
    const reminder = this.publicReminder(rawReminder);
    return {
      id: reminder.id,
      type: "reminder",
      title: reminder.title,
      description: reminder.description,
      customer: reminder.customer,
      dueAt: reminder.dueAt ?? reminder.createdAt,
      priority: reminder.priority,
      status: reminder.status,
      source: reminder.source,
      linkedEntity: { type: "reminder", id: reminder.id },
      actions: reminder.status === "DONE" ? ["open"] : ["call", "complete", "open"]
    };
  }

  private publicHomeVisit(homeVisit: {
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
      id: homeVisit.id,
      customerId: homeVisit.customerId ?? null,
      title: homeVisit.title,
      location: homeVisit.location ?? null,
      notes: homeVisit.notes ?? null,
      startsAt: homeVisit.startsAt,
      endsAt: homeVisit.endsAt ?? null,
      status: homeVisitStatus(homeVisit.status),
      customer: publicCustomer(homeVisit.customer),
      createdAt: homeVisit.createdAt,
      updatedAt: homeVisit.updatedAt
    };
  }

  private publicHomeVisitWorkItem(rawHomeVisit: Parameters<CoreController["publicHomeVisit"]>[0]) {
    const homeVisit = this.publicHomeVisit(rawHomeVisit);
    return {
      id: homeVisit.id,
      type: "home_visit",
      title: homeVisit.title,
      description: homeVisit.notes ?? homeVisit.location,
      location: homeVisit.location,
      notes: homeVisit.notes,
      customer: homeVisit.customer,
      dueAt: homeVisit.startsAt,
      priority: "NORMAL",
      status: homeVisit.status,
      source: "app",
      linkedEntity: { type: "home_visit", id: homeVisit.id },
      actions: homeVisit.status === "DONE" ? ["open"] : ["navigate", "complete", "open"]
    };
  }

  private publicAppointmentWorkItem(appointment: Parameters<CoreController["publicHomeVisit"]>[0]) {
    return {
      id: appointment.id,
      type: "appointment",
      title: appointment.title,
      description: appointment.notes ?? appointment.location,
      location: appointment.location ?? null,
      notes: appointment.notes ?? null,
      customer: publicCustomer(appointment.customer),
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt ?? null,
      priority: "NORMAL",
      status: appointment.status,
      source: "app",
      linkedEntity: { type: "appointment", id: appointment.id },
      actions: appointment.status === "DONE" ? ["open"] : ["complete", "open"]
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
    if (input.actionType === "CREATE_REMINDER") {
      const existing = await this.reminders.findByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) {
        return { type: input.actionType, duplicate: true, reminder: existing };
      }
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!title) {
        throw new BadRequestException("AI pending action payload is missing reminder title");
      }
      const reminder = await this.reminders.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : "NORMAL",
        dueAt: await this.resolveAiReminderDueAt(input.businessId, input.payload),
        source: "ai_pending_action",
        sourceRef: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "reminder",
        entityId: reminder.id,
        action: "CREATE_REMINDER_FROM_PENDING_ACTION",
        after: reminder as Prisma.InputJsonValue
      });
      return { type: input.actionType, duplicate: false, reminder };
    }

    if (input.actionType === "COMPLETE_REMINDER") {
      const reminderId = typeof input.payload.reminderId === "string" ? input.payload.reminderId : undefined;
      if (!reminderId) {
        throw new BadRequestException("Action payload is missing reminderId");
      }
      const reminder = await this.reminders.complete(input.businessId, reminderId);
      if (!reminder) {
        throw new NotFoundException("Reminder not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "structured_action",
        entityType: "reminder",
        entityId: reminder.id,
        action: "COMPLETE_REMINDER_FROM_ACTION",
        after: reminder as Prisma.InputJsonValue
      });
      return { type: input.actionType, reminder };
    }

    if (input.actionType === "UPDATE_REMINDER") {
      const reminderId = typeof input.payload.reminderId === "string" ? input.payload.reminderId : undefined;
      if (!reminderId) {
        throw new BadRequestException("Action payload is missing reminderId");
      }
      const reminder = await this.reminders.update({
        businessId: input.businessId,
        reminderId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : input.payload.priority === "NORMAL" ? "NORMAL" : undefined,
        dueAt: typeof input.payload.dueAt === "string" ? await this.resolveAiReminderDueAt(input.businessId, input.payload) : undefined,
        status: input.payload.status === "DONE" || input.payload.status === "OPEN" || input.payload.status === "CANCELLED"
          ? input.payload.status
          : undefined
      });
      if (!reminder) {
        throw new NotFoundException("Reminder not found");
      }
      return { type: input.actionType, reminder };
    }

    if (input.actionType === "CREATE_CUSTOMER") {
      const name = typeof input.payload.name === "string" ? input.payload.name : undefined;
      if (!name) {
        throw new BadRequestException("AI pending action payload is missing customer name");
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
        source: "ai_pending_action",
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

    if (input.actionType === "CREATE_APPOINTMENT" || input.actionType === "CREATE_HOME_VISIT") {
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      const startsAt = typeof input.payload.startsAt === "string" ? input.payload.startsAt : undefined;
      if (!title || !startsAt) {
        throw new BadRequestException("AI pending action payload is missing title or startsAt");
      }
      const repository = input.actionType === "CREATE_HOME_VISIT" ? this.homeVisits : this.appointments;
      const result = await repository.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
        startsAt: parseRequiredDate(startsAt),
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined
      });
      const entityType = input.actionType === "CREATE_HOME_VISIT" ? "home_visit" : "appointment";
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType,
        entityId: result.id,
        action: `${input.actionType}_FROM_PENDING_ACTION`,
        after: result as Prisma.InputJsonValue
      });
      return input.actionType === "CREATE_HOME_VISIT"
        ? { type: input.actionType, homeVisit: result }
        : { type: input.actionType, appointment: result };
    }

    if (input.actionType === "UPDATE_APPOINTMENT" || input.actionType === "UPDATE_HOME_VISIT") {
      const entityId = input.actionType === "UPDATE_HOME_VISIT"
        ? typeof input.payload.homeVisitId === "string" ? input.payload.homeVisitId : undefined
        : typeof input.payload.appointmentId === "string" ? input.payload.appointmentId : undefined;
      if (!entityId) {
        throw new BadRequestException(input.actionType === "UPDATE_HOME_VISIT"
          ? "Action payload is missing homeVisitId"
          : "Action payload is missing appointmentId");
      }
      const status = input.payload.status === "DONE" || input.payload.status === "OPEN" || input.payload.status === "CANCELLED"
        ? input.payload.status
        : undefined;
      const commonUpdate: {
        businessId: string;
        customerId?: string;
        title?: string;
        location?: string;
        notes?: string;
        startsAt?: Date;
        endsAt?: Date;
        status?: "OPEN" | "DONE" | "CANCELLED";
      } = {
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
        startsAt: typeof input.payload.startsAt === "string" ? parseRequiredDate(input.payload.startsAt) : undefined,
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined,
        status
      };
      const result = input.actionType === "UPDATE_HOME_VISIT"
        ? await this.homeVisits.update({ ...commonUpdate, homeVisitId: entityId })
        : await this.appointments.update({ ...commonUpdate, appointmentId: entityId });
      if (!result) {
        throw new NotFoundException(input.actionType === "UPDATE_HOME_VISIT" ? "Home visit not found" : "Appointment not found");
      }
      return input.actionType === "UPDATE_HOME_VISIT"
        ? { type: input.actionType, homeVisit: result }
        : { type: input.actionType, appointment: result };
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
        dueAt: await this.resolveAiReminderDueAt(input.businessId, input.payload),
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
        dueAt: typeof input.payload.dueAt === "string" ? await this.resolveAiReminderDueAt(input.businessId, input.payload) : undefined,
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

    if (input.actionType === "DELETE_WORK_ITEM") {
      const itemType = typeof input.payload.itemType === "string" ? input.payload.itemType : undefined;
      const itemId = typeof input.payload.itemId === "string" ? input.payload.itemId : undefined;
      if (!itemType || !itemId) {
        throw new BadRequestException("Action payload is missing itemType or itemId");
      }
      if (itemType === "reminder") {
        const item = await this.reminders.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Reminder not found");
        return { type: input.actionType, item };
      }
      if (itemType === "home_visit") {
        const item = await this.homeVisits.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Home visit not found");
        return { type: input.actionType, item };
      }
      if (itemType === "appointment") {
        const item = await this.appointments.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Appointment not found");
        return { type: input.actionType, item };
      }
      if (itemType === "quote") {
        const item = await this.quotes.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Quote not found");
        return { type: input.actionType, item };
      }
      if (itemType === "note") {
        const item = await this.notes.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Customer note not found");
        return { type: input.actionType, item };
      }
      throw new BadRequestException("Unsupported work item type");
    }

    if (input.actionType === "CREATE_NOTE") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      const text = typeof input.payload.text === "string" ? input.payload.text : undefined;
      if (!customerId || !text) {
        throw new BadRequestException("AI pending action payload is missing note customerId or text");
      }
      const note = await this.notes.create({
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
        source: "ai_pending_action",
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
    const useMockStt = getEnv("MOCK_STT_PROVIDER", "false") === "true";
    const audioBody = input.audio.buffer.slice(input.audio.byteOffset, input.audio.byteOffset + input.audio.byteLength) as ArrayBuffer;
    const response = await fetch(`${voiceBaseUrl}${useMockStt ? "/stt/mock" : "/stt/openai"}`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(voiceBaseUrl)),
        "x-internal-secret": getInternalApiSecret(),
        ...(useMockStt
          ? { "content-type": "application/json" }
          : {
              "content-type": input.contentType,
              "x-audio-filename": input.filename,
              "x-language-code": input.languageCode
            })
      },
      body: useMockStt ? JSON.stringify({ languageCode: input.languageCode }) : audioBody
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
      headers: {
        ...(await cloudRunServiceAuthHeaders(aiBaseUrl)),
        "content-type": "application/json",
        "x-internal-secret": getInternalApiSecret()
      },
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

  private voiceResultFromStoredCommand(command: { transcript?: string | null; executionResult?: Prisma.JsonValue | null }): VoiceCommandResult {
    const execution = this.asRecord(command.executionResult);
    const storedResult = this.asRecord(execution.voiceResult);
    if (typeof storedResult.state === "string") {
      return storedResult as VoiceCommandResult;
    }
    if (typeof execution.status === "string" && Array.isArray(execution.results)) {
      return this.buildVoiceCommandResult({
        transcript: command.transcript ?? null,
        execution: {
          status: execution.status,
          results: execution.results.filter((result): result is Record<string, unknown> => typeof result === "object" && result !== null)
        },
        timeZone: "Asia/Jerusalem"
      });
    }

    return this.buildFailedVoiceCommandResult({
      transcript: command.transcript ?? null,
      message: typeof execution.message === "string" ? execution.message : "Voice command execution failed"
    });
  }

  private buildFailedVoiceCommandResult(input: { transcript?: string | null; message: string }): VoiceCommandResult {
    const unclearRecording = input.message.includes("לא זוהה דיבור ברור") || !input.transcript;
    return {
      state: "failed",
      title: unclearRecording ? "לא הצלחתי להבין את ההקלטה" : "לא הצלחתי לבצע את הפקודה",
      summary: unclearRecording
        ? "אפשר להקליט שוב או להקליד את הפקודה."
        : "אפשר לבדוק את מה שנשמע, להקליט שוב או ליצור את הפעולה ידנית.",
      transcript: input.transcript ?? null,
      items: [],
      primaryAction: "הקלט שוב",
      secondaryActions: ["סגור"]
    };
  }

  private buildVoiceCommandResult(input: {
    transcript: string | null;
    execution: VoiceCommandExecutionResult;
    timeZone: string;
  }): VoiceCommandResult {
    const items = input.execution.results.map((result, index) => this.voiceResultItemFromExecutionResult(result, index, input.timeZone));
    if (items.length === 0) {
      return {
        state: "unsupported",
        title: "לא מצאתי פעולה מתאימה",
        summary: "אפשר לבקש ליצור לקוח, תזכורת, ביקור, הצעת מחיר או הערת לקוח.",
        transcript: input.transcript,
        items: [],
        primaryAction: "הקלט שוב",
        secondaryActions: ["סגור"]
      };
    }

    const pendingItems = items.filter((item) => item.status === "pending");
    const pendingCount = pendingItems.length;
    const missingPendingCount = pendingItems.filter((item) => item.missingFields.length > 0).length;
    const failedCount = items.filter((item) => item.status === "failed").length;
    const doneCount = items.length - pendingCount - failedCount;
    const state: VoiceCommandResult["state"] = missingPendingCount > 0
      ? "needs_input"
      : pendingCount > 0
        ? "needs_review"
        : failedCount === items.length
          ? "failed"
          : "done";

    return {
      state,
      title: state === "needs_input" ? "צריך עוד פרט" : state === "needs_review" ? "לאישור" : state === "failed" ? "לא הצלחתי לבצע את הפקודה" : "בוצע",
      summary: this.voiceResultSummary({ state, doneCount, pendingCount, failedCount }),
      transcript: input.transcript,
      items,
      primaryAction: "סגור",
      secondaryActions: state === "done" ? ["הקלט שוב"] : ["אשר מאוחר יותר", "הקלט שוב"]
    };
  }

  private voiceResultSummary(input: {
    state: VoiceCommandResult["state"];
    doneCount: number;
    pendingCount: number;
    failedCount: number;
  }) {
    if (input.state === "needs_input") {
      if (input.doneCount > 0) {
        return `ביצעתי ${input.doneCount} ${input.doneCount === 1 ? "פעולה" : "פעולות"}. יש ${input.pendingCount} ${input.pendingCount === 1 ? "פעולה שצריכה" : "פעולות שצריכות"} השלמה.`;
      }
      return "הבנתי את הפעולה, אבל חסר פרט כדי להשלים אותה.";
    }
    if (input.state === "needs_review") {
      return input.pendingCount === 1
        ? "הבנתי את הפעולה. אפשר לפתוח, לערוך ולאשר לפני שהיא נשמרת."
        : `הבנתי ${input.pendingCount} פעולות. אפשר לפתוח כל כרטיס, לערוך ולאשר לפני שמירה.`;
    }
    if (input.state === "failed") {
      return "אפשר לבדוק את מה שנשמע, להקליט שוב או ליצור את הפעולה ידנית.";
    }
    return input.doneCount === 1 ? "ביצעתי פעולה אחת מהפקודה הקולית." : `ביצעתי ${input.doneCount} פעולות מהפקודה הקולית.`;
  }

  private voiceResultItemFromExecutionResult(result: Record<string, unknown>, index: number, timeZone: string): VoiceCommandResult["items"][number] {
    const actionType = typeof result.actionType === "string" ? result.actionType : "ACTION";
    const status = result.status === "PENDING" ? "pending" : result.status === "EXECUTED" ? "created" : "failed";
    const executionPayload = this.asRecord(result.result);
    const aiPendingAction = this.asRecord(result.aiPendingAction);
    const payload = this.asRecord(aiPendingAction.payload);
    const entity = this.voiceResultEntity(executionPayload);
    const fields = status === "pending"
      ? this.voicePendingFields(actionType, payload, aiPendingAction, timeZone)
      : this.voiceEntityFields(actionType, entity, timeZone);

    return {
      id: typeof result.idempotencyKey === "string" ? result.idempotencyKey : `${actionType}:${index}`,
      actionType,
      kind: this.voiceResultKind(actionType),
      status,
      title: this.voiceResultTitle(actionType, status),
      subtitle: status === "pending" ? this.pendingReason(aiPendingAction) : undefined,
      payload: status === "pending" ? payload : entity,
      fields,
      entityId: typeof entity.id === "string" ? entity.id : undefined,
      aiPendingActionId: typeof aiPendingAction.id === "string" ? aiPendingAction.id : undefined,
      missingFields: this.stringList(aiPendingAction.missingFields)
    };
  }

  private voiceResultEntity(result: Record<string, unknown>) {
    for (const value of [result.customer, result.reminder, result.homeVisit, result.appointment, result.quote, result.note, result.item]) {
      const record = this.asRecord(value);
      if (Object.keys(record).length > 0) return record;
    }
    return result;
  }

  private voiceResultKind(actionType: string): VoiceCommandResult["items"][number]["kind"] {
    if (actionType.includes("CUSTOMER") && !actionType.includes("NOTE")) return "customer";
    if (actionType.includes("HOME_VISIT") || actionType.includes("APPOINTMENT")) return "home_visit";
    if (actionType.includes("QUOTE")) return "quote";
    if (actionType.includes("NOTE")) return "note";
    if (actionType.includes("REMINDER")) return "reminder";
    return "action";
  }

  private voiceResultTitle(actionType: string, status: VoiceCommandResult["items"][number]["status"]) {
    const prefix = status === "pending" ? "" : status === "completed" ? "הושלם: " : "";
    if (status === "pending") {
      if (actionType === "CREATE_CUSTOMER") return "לקוח חדש";
      if (actionType === "CREATE_REMINDER") return "תזכורת חדשה";
      if (actionType === "CREATE_HOME_VISIT" || actionType === "CREATE_APPOINTMENT") return "ביקור בית חדש";
      if (actionType === "CREATE_QUOTE") return "הצעת מחיר חדשה";
    }
    if (actionType.includes("CUSTOMER") && !actionType.includes("NOTE")) return `${prefix}לקוח`;
    if (actionType.includes("HOME_VISIT") || actionType.includes("APPOINTMENT")) return `${prefix}ביקור בית`;
    if (actionType.includes("QUOTE")) return `${prefix}הצעת מחיר`;
    if (actionType.includes("NOTE")) return `${prefix}הערת לקוח`;
    if (actionType.includes("REMINDER")) return `${prefix}תזכורת`;
    return `${prefix}פעולה`;
  }

  private voicePendingFields(actionType: string, payload: Record<string, unknown>, aiPendingAction: Record<string, unknown>, timeZone: string) {
    const missingFields = new Set(this.stringList(aiPendingAction.missingFields));
    const fields = this.voiceEntityFields(actionType, payload, timeZone);
    for (const field of missingFields) {
      if (!fields.some((item) => item.label === this.voiceFieldLabel(field))) {
        fields.push({ label: this.voiceFieldLabel(field), value: "חסר", state: "missing" as const });
      }
    }
    return fields.map((field) => missingFields.has(this.fieldKeyFromHebrewLabel(field.label)) ? { ...field, state: "missing" as const, value: field.value || "חסר" } : field);
  }

  private voiceEntityFields(actionType: string, entity: Record<string, unknown>, timeZone: string): VoiceCommandResult["items"][number]["fields"] {
    const fields: VoiceCommandResult["items"][number]["fields"] = [];
    const isCustomerAction = actionType.includes("CUSTOMER") && !actionType.includes("NOTE");
    const isWorkItemAction = actionType.includes("REMINDER") ||
      actionType.includes("HOME_VISIT") ||
      actionType.includes("APPOINTMENT") ||
      actionType.includes("QUOTE");
    const title = isCustomerAction
      ? this.stringValue(entity.name)
      : this.stringValue(entity.title) ?? this.stringValue(entity.text);
    if (title) fields.push({ label: isCustomerAction ? "שם" : "נושא", value: title, state: "normal" });
    const phone = this.stringValue(entity.phone);
    if (phone) fields.push({ label: "טלפון", value: phone, state: "normal" });
    const customerName = this.stringValue(this.asRecord(entity.customer).name) ??
      this.stringValue(entity.customerName) ??
      (isWorkItemAction ? this.stringValue(entity.name) : undefined);
    if (customerName) fields.push({ label: "לקוח", value: customerName, state: "normal" });
    const dueAt = this.stringValue(entity.dueAt) ?? this.stringValue(entity.startsAt);
    if (dueAt) fields.push({ label: "מועד", value: this.formatVoiceDate(dueAt, timeZone), state: "normal" });
    const amount = this.stringValue(entity.estimatedAmount);
    if (amount) fields.push({ label: "סכום", value: amount, state: "normal" });
    const location = this.stringValue(entity.location) ?? this.stringValue(entity.address);
    if (location) fields.push({ label: "כתובת", value: location, state: "normal" });
    return fields;
  }

  private pendingReason(aiPendingAction: Record<string, unknown>) {
    const missingFields = this.stringList(aiPendingAction.missingFields).map((field) => this.voiceFieldLabel(field));
    return missingFields.length > 0 ? `חסר: ${missingFields.join(", ")}` : "ממתין לאישור";
  }

  private voiceFieldLabel(field: string) {
    const labels: Record<string, string> = {
      customerId: "לקוח",
      customerName: "לקוח",
      reminderId: "תזכורת",
      appointmentId: "פגישה",
      homeVisitId: "ביקור בית",
      quoteId: "הצעת מחיר",
      title: "נושא",
      text: "תוכן",
      name: "שם",
      phone: "טלפון",
      dueAt: "מועד",
      startsAt: "מועד",
      estimatedAmount: "סכום",
      location: "כתובת"
    };
    return labels[field] ?? field;
  }

  private fieldKeyFromHebrewLabel(label: string) {
    const labels: Record<string, string> = {
      לקוח: "customerId",
      תזכורת: "reminderId",
      ביקור: "homeVisitId",
      "הצעת מחיר": "quoteId",
      נושא: "title",
      תוכן: "text",
      שם: "name",
      טלפון: "phone",
      מועד: "dueAt",
      סכום: "estimatedAmount",
      כתובת: "location"
    };
    return labels[label] ?? label;
  }

  private formatVoiceDate(value: string, timeZone: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("he-IL", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  private stringValue(value: unknown) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Prisma.Decimal) return value.toString();
    return undefined;
  }

  private stringList(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    const notificationDelivery = await this.sendNotification(notification);

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
      log("warn", "notification delivery skipped without active device tokens", {
        businessId: notification.businessId,
        notificationId: notification.id
      });
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

    log("info", "firebase notification delivery finished", {
      businessId: notification.businessId,
      notificationId: notification.id,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      errors: response.responses
        .filter((result) => !result.success)
        .map((result) => result.error?.code ?? result.error?.message ?? "unknown")
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
    const expected = getInternalApiSecret();
    const actual = headerValue(headers, "x-internal-secret");
    if (actual !== expected) {
      throw new UnauthorizedException("Missing or invalid internal secret");
    }
  }

  private async requireInternalScheduler(headers: RequestHeaders): Promise<void> {
    const token = parseOptionalBearerToken(headers);
    const allowedServiceAccount = getEnv("SCHEDULER_SERVICE_ACCOUNT_EMAIL", "");
    const audience = getEnv("SCHEDULER_OIDC_AUDIENCE", "");

    if (!allowedServiceAccount || !audience) {
      this.requireInternalSecret(headers);
      return;
    }

    if (!token) {
      throw new UnauthorizedException("Missing scheduler identity token");
    }

    try {
      await verifyGoogleOidcToken({
        token,
        audiences: audience.split(",").map((value) => value.trim()).filter(Boolean),
        allowedServiceAccounts: allowedServiceAccount.split(",").map((value) => value.trim()).filter(Boolean)
      });
    } catch {
      throw new UnauthorizedException("Missing or invalid scheduler identity token");
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
    RemindersRepository,
    NotesRepository,
    AppointmentsRepository,
    HomeVisitsRepository,
    QuotesRepository,
    NotificationsRepository,
    DeviceTokensRepository,
    OwnerVoiceCommandsRepository,
    AiPendingActionsRepository
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
