import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getEnv } from "@myclient/common";
import { IdempotencyKeySchema, PaginationQuerySchema } from "@myclient/contracts";

export type RequestHeaders = Record<string, string | string[] | undefined>;

export type VoiceCommandExecutionResult = {
  status: string;
  results: Array<Record<string, unknown>>;
};

export function requiredIdempotencyKey(headers: RequestHeaders): string {
  const value = headers["x-idempotency-key"] ?? headers["X-Idempotency-Key"];
  const firstValue = Array.isArray(value) ? value[0] : value;
  const parsed = IdempotencyKeySchema.safeParse(firstValue);
  if (!parsed.success) {
    throw new BadRequestException("Missing or invalid x-idempotency-key header");
  }
  return parsed.data;
}

export function formatCaller(callerPhone: string | undefined): string {
  return callerPhone ?? "מספר לא מזוהה";
}

export function buildReminderFromCallDescription(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `מתקשר: ${caller}\nהודעה: ${transcript}`;
  }

  return `מתקשר: ${caller}\nהלקוח ביקש שתחזור אליו.`;
}

export function buildReminderNotificationBody(callerPhone: string | undefined, transcript: string | undefined): string {
  const caller = formatCaller(callerPhone);
  if (transcript) {
    return `${caller}: ${transcript}`;
  }

  return `${caller} ביקש שתחזור אליו.`;
}

export function buildReminderReminderBody(reminder: { title: string; description?: string | null }) {
  return reminder.description ? `${reminder.title}\n${reminder.description}` : reminder.title;
}

export function parseOptionalDate(value: string | null | undefined): Date | null | undefined {
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

export function parseRequiredDate(value: string): Date {
  const parsed = parseOptionalDate(value);
  if (!parsed) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return parsed;
}

export function timeOrZero(value: string | number | Date | null | undefined) {
  return value ? new Date(value).getTime() : 0;
}

export function scheduledTimeOrZero(item: { dueAt?: Date | string | null; startsAt?: Date | string | null }) {
  return timeOrZero(item.dueAt ?? item.startsAt);
}

export function getZonedParts(date: Date, timeZone: string) {
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

export function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return zonedAsUtc - date.getTime();
}

export function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string) {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  return new Date(guess.getTime() - getTimeZoneOffsetMs(guess, timeZone));
}

export function addLocalDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

export function defaultAiReminderDueAt(timeZone: string, now = new Date()) {
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

export function parseAiDueAt(value: string, timeZone: string) {
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

export function tryParseAiDueAt(value: string, timeZone: string) {
  try {
    return parseAiDueAt(value, timeZone);
  } catch {
    return undefined;
  }
}

export function parseHebrewVoiceDueAt(text: string, timeZone: string, now = new Date()) {
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

export function parseHebrewRelativeDueAt(text: string, now = new Date()) {
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

export function parseHebrewNumber(value: string) {
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

export function parseHebrewHour(value: string, context: string) {
  const numeric = Number(value);
  const hour = Number.isFinite(numeric) && numeric > 0 ? numeric : {
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

export function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function authProviderName() {
  return getEnv("AUTH_PROVIDER", "mock");
}

export function requireAudioBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) {
    throw new BadRequestException("Audio body is required");
  }
  if (body.byteLength > 5 * 1024 * 1024) {
    throw new BadRequestException("Audio body is too large");
  }
  return body;
}

export function notificationProviderName() {
  return getEnv("MOCK_FCM_PROVIDER", "true") === "true" ? "mock-fcm" : "firebase-fcm";
}

export function publicDeviceToken(deviceToken: {
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

export function publicCustomer(customer: { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null; createdAt?: Date } | null | undefined) {
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

export function decodePageCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
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

export function encodePageCursor(item: { id: string; createdAt: Date }): string {
  return Buffer.from(JSON.stringify({
    createdAt: item.createdAt.toISOString(),
    id: item.id
  })).toString("base64url");
}

export function paginatedResponse<T extends { id: string; createdAt: Date }>(items: T[], limit: number) {
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

export function paginationFromQuery(query: unknown) {
  return paginationFromParsedQuery(PaginationQuerySchema.parse(query));
}

export function paginationFromParsedQuery(command: { limit: number; cursor?: string }) {
  return {
    limit: command.limit,
    cursor: decodePageCursor(command.cursor)
  };
}

export function reminderStatus(status: string) {
  return status;
}

export function homeVisitStatus(status: string) {
  return status;
}

export function startOfLocalDate(dateText: string | undefined, timeZone: string) {
  const nowParts = getZonedParts(new Date(), timeZone);
  const match = dateText?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parts = match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0 }, timeZone);
}

export function isSameUtcInstant(a: Date, b: Date) {
  return a.getTime() === b.getTime();
}

export function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function snoozeDueAt(preset: "IN_15_MINUTES" | "IN_2_HOURS" | "TOMORROW_09_00", timeZone: string, now = new Date()) {
  if (preset === "IN_15_MINUTES") {
    return new Date(now.getTime() + 15 * 60 * 1000);
  }
  if (preset === "IN_2_HOURS") {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
  }
  const parts = addLocalDays(getZonedParts(now, timeZone), 1);
  return zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 9, minute: 0 }, timeZone);
}

export function parseOptionalAmount(value: string | number | Prisma.Decimal | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Prisma.Decimal(value);
}

export function callIvrSelection(call: { selectedDigit?: string | null }) {
  if (call.selectedDigit === "1") return "CALLBACK_REQUESTED";
  if (call.selectedDigit === "2") return "MESSAGE_RECORDED";
  if (call.selectedDigit === "3") return "URGENT_MESSAGE";
  return "NO_SELECTION";
}

export function callDisplayStatus(call: { selectedDigit?: string | null; transcripts?: Array<{ taskId?: string | null }> }) {
  if (call.transcripts?.some((transcript) => transcript.taskId)) {
    return "TASK_CREATED";
  }
  if (call.selectedDigit) {
    return "NO_ACTION";
  }
  return "NO_ACTION";
}
