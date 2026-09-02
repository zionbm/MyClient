import type { AssistantPlan } from "@myclient/contracts";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function dateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function localDate(date: Date, timezone: string) {
  const parts = dateTimeParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addLocalDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return next.toISOString().slice(0, 10);
}

function localDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateTimeParts(candidate, timezone);
    const represented = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  return candidate;
}

function environment(context: unknown) {
  const value = objectValue(objectValue(context).environment);
  const now = typeof value.now === "string" && !Number.isNaN(new Date(value.now).getTime())
    ? new Date(value.now)
    : new Date();
  const timezone = typeof value.timezone === "string" && value.timezone ? value.timezone : "Asia/Jerusalem";
  return { now, timezone };
}

function isTodayOverviewQuestion(transcript: string) {
  const compact = transcript.replace(/[?？]/g, "").replace(/\s+/g, " ").trim();
  return /(?:מה|איזה|אילו).*(?:נשאר|נותר|פתוח|מחכה).*(?:היום)/u.test(compact)
    || /(?:מה|איזה|אילו).*(?:היום).*(?:נשאר|נותר|פתוח|מחכה)/u.test(compact);
}

function explicitCustomerActivity(transcript: string, context: unknown): AssistantPlan | null {
  if (!/לקוח(?:ה)?\s+חדש(?:ה)?\s+בשם/u.test(transcript)) return null;
  const afterName = transcript.split(/לקוח(?:ה)?\s+חדש(?:ה)?\s+בשם/u)[1]?.trim();
  if (!afterName) return null;
  const activityMarker = /\s+ו?(?:הוסף|הוסיפי|תוסיף|תוסיפי|צור|צרי|תיצור|תצרי)\s+(?:לי\s+)?(עבודה|ביקור)(?=\s|$)/u;
  const marker = activityMarker.exec(afterName);
  if (!marker || marker.index <= 0) return null;
  const customerName = afterName.slice(0, marker.index).replace(/[,.;]+$/g, "").trim();
  if (!customerName) return null;

  const activityType = marker[1] === "ביקור" ? "visit" : "job";
  const activityText = afterName.slice(marker.index + marker[0].length).trim();
  const timeMatch = /(?:בשעה\s*)?(\d{1,2})(?::(\d{2}))?/u.exec(activityText);
  const relativeDay = activityText.includes("מחר") ? 1 : activityText.includes("היום") ? 0 : null;
  const { now, timezone } = environment(context);
  let startsAt: string | undefined;
  if (relativeDay !== null && timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] ?? "0");
    if (hour <= 23 && minute <= 59) {
      const date = addLocalDays(localDate(now, timezone), relativeDay);
      startsAt = localDateTimeToUtc(date, `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, timezone).toISOString();
    }
  }

  const activityTool = activityType === "job" ? "CREATE_JOB" as const : "CREATE_VISIT" as const;
  return {
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { customerName, activityType, ...(startsAt ? { startsAt } : {}) },
    steps: [
      {
        stepId: "create_customer",
        kind: "WRITE",
        tool: "CREATE_CUSTOMER",
        dependsOn: [],
        input: { name: customerName },
        confidence: 1,
        requiresExplicitConfirmation: false
      },
      {
        stepId: `create_${activityType}`,
        kind: "WRITE",
        tool: activityTool,
        dependsOn: ["create_customer"],
        input: {
          title: activityType === "job" ? "עבודה" : "ביקור",
          customerRef: { stepId: "create_customer", outputField: "entityId" },
          ...(startsAt ? { startsAt } : {})
        },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  };
}

export function deterministicAssistantPlan(transcript: string, context: unknown): AssistantPlan | null {
  if (isTodayOverviewQuestion(transcript)) {
    const { now, timezone } = environment(context);
    return {
      version: "2",
      requestKind: "QUESTION",
      language: "he-IL",
      extractedFacts: {},
      steps: [{
        stepId: "today_overview",
        kind: "READ",
        tool: "GET_TODAY_OVERVIEW",
        dependsOn: [],
        input: { date: localDate(now, timezone) },
        confidence: 1,
        requiresExplicitConfirmation: false
      }]
    };
  }
  return explicitCustomerActivity(transcript, context);
}
