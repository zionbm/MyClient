import type { AssistantPlan } from "@myclient/contracts";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
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
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
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
  const now =
    typeof value.now === "string" && !Number.isNaN(new Date(value.now).getTime()) ? new Date(value.now) : new Date();
  const timezone = typeof value.timezone === "string" && value.timezone ? value.timezone : "Asia/Jerusalem";
  return { now, timezone };
}

function isTodayOverviewQuestion(transcript: string) {
  const compact = transcript.replace(/[?？]/g, "").replace(/\s+/g, " ").trim();
  return (
    /(?:מה|איזה|אילו).*(?:נשאר|נותר|פתוח|מחכה).*(?:היום)/u.test(compact) ||
    /(?:מה|איזה|אילו).*(?:היום).*(?:נשאר|נותר|פתוח|מחכה)/u.test(compact)
  );
}

function explicitStandaloneCustomer(transcript: string): AssistantPlan | null {
  const match =
    /^(?:בבקשה\s+)?(?:צור|צרי|תיצור|תצרי|הוסף|הוסיפי|תוסיף|תוסיפי)\S*\s+(?:לי\s+)?לקוח(?:ה)?\s+חדש(?:ה)?\s+בשם\s+(.+?)[.!]?$/u.exec(
      transcript.trim()
    );
  const name = match?.[1]?.trim();
  if (!name || /\s+ו(?:תוסיף|תוסיפי|הוסף|הוסיפי|צור|צרי|תיצור|תצרי|תקבע|תקבעי|קבע|קבעי)\b/u.test(name)) return null;
  return {
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { customerName: name },
    steps: [
      {
        stepId: "create_customer",
        kind: "WRITE",
        tool: "CREATE_CUSTOMER",
        dependsOn: [],
        input: { name },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  };
}

function spokenHour(text: string) {
  const numeric = /(?:בשעה\s*)?(\d{1,2})(?::(\d{2}))?/u.exec(text);
  let hour: number | undefined;
  let minute = 0;
  if (numeric) {
    hour = Number(numeric[1]);
    minute = Number(numeric[2] ?? "0");
  } else {
    const values: Array<[RegExp, number]> = [
      [/שת(?:ים|יים)\s+עשרה/u, 12],
      [/אחת\s+עשרה/u, 11],
      [/עשר/u, 10],
      [/תשע/u, 9],
      [/שמונה/u, 8],
      [/שבע/u, 7],
      [/שש/u, 6],
      [/חמש/u, 5],
      [/ארבע/u, 4],
      [/שלוש/u, 3],
      [/שת(?:ים|יים)/u, 2],
      [/אחת/u, 1]
    ];
    hour = values.find(([pattern]) => pattern.test(text))?.[1];
  }
  if (hour === undefined || hour > 23 || minute > 59) return undefined;
  if (hour <= 11 && /(?:בצהריים|אחר\s+הצהריים|בערב)/u.test(text)) hour += 12;
  return { hour, minute };
}

function standaloneTask(transcript: string): AssistantPlan | null {
  const match =
    /^(?:בבקשה\s+)?(?:צור|צרי|תיצור|תצרי|הוסף|הוסיפי|תוסיף|תוסיפי)\S*\s+(?:לי\s+)?משימה(?:\s+חדשה)?\s+(.+?)[.!]?$/u.exec(
      transcript.trim()
    );
  const title = match?.[1]?.trim();
  if (!title) return null;
  const needsInterpretation =
    /(?:לקוח|לקוחה|אצל|עבור|היום|מחר|מחרתיים|ביום|בבוקר|בצהריים|בערב|בלילה|בשעה|\d{1,2}:\d{2})/u.test(title);
  if (needsInterpretation) return null;
  return {
    version: "2",
    requestKind: "ACTION",
    language: "he-IL",
    extractedFacts: { taskTitle: title },
    steps: [
      {
        stepId: "create_task",
        kind: "WRITE",
        tool: "CREATE_TASK",
        dependsOn: [],
        input: { title },
        confidence: 1,
        requiresExplicitConfirmation: false
      }
    ]
  };
}

function explicitCustomerActivity(transcript: string, context: unknown): AssistantPlan | null {
  if (!/לקוח(?:ה)?\s+חדש(?:ה)?\s+בשם/u.test(transcript)) return null;
  const afterName = transcript.split(/לקוח(?:ה)?\s+חדש(?:ה)?\s+בשם/u)[1]?.trim();
  if (!afterName) return null;
  const activityMarker =
    /\s+ו?(?:הוסף|הוסיפי|תוסיף|תוסיפי|צור|צרי|תיצור|תצרי|קבע|קבעי|תקבע|תקבעי)\s+(?:לי\s+)?(?:(?:אצל(?:ו|ה)?)\s+)?(עבודה|ביקור)(?=\s|$)/u;
  const marker = activityMarker.exec(afterName);
  if (!marker || marker.index <= 0) return null;
  const customerName = afterName
    .slice(0, marker.index)
    .replace(/[,.;]+$/g, "")
    .trim();
  if (!customerName) return null;

  const activityType = marker[1] === "ביקור" ? "visit" : "job";
  const activityText = afterName.slice(marker.index + marker[0].length).trim();
  const title =
    /(?:^|\s)בשם\s+(.+?)(?=\s+(?:היום|מחר|מחרתיים|ביום|בשעה)|[,.;]|$)/u.exec(activityText)?.[1]?.trim() ??
    (activityType === "job" ? "עבודה" : "ביקור");
  const time = spokenHour(activityText);
  const relativeDay = activityText.includes("מחרתיים")
    ? 2
    : activityText.includes("מחר")
      ? 1
      : activityText.includes("היום")
        ? 0
        : null;
  const { now, timezone } = environment(context);
  let startsAt: string | undefined;
  if (relativeDay !== null && time) {
    const { hour, minute } = time;
    if (hour <= 23 && minute <= 59) {
      const date = addLocalDays(localDate(now, timezone), relativeDay);
      startsAt = localDateTimeToUtc(
        date,
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        timezone
      ).toISOString();
    }
  }

  const activityTool = activityType === "job" ? ("CREATE_JOB" as const) : ("CREATE_VISIT" as const);
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
          title,
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
      steps: [
        {
          stepId: "today_overview",
          kind: "READ",
          tool: "GET_TODAY_OVERVIEW",
          dependsOn: [],
          input: { date: localDate(now, timezone) },
          confidence: 1,
          requiresExplicitConfirmation: false
        }
      ]
    };
  }
  return (
    explicitCustomerActivity(transcript, context) ??
    explicitStandaloneCustomer(transcript) ??
    standaloneTask(transcript)
  );
}
