import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://myclient:myclient@localhost:5432/myclient?schema=public";
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
const runId = Date.now().toString();
const firebaseUid = `assistant_acceptance_${runId}`;
const authorization = `Bearer mock:${firebaseUid}`;
const reportPath = `/tmp/myclient-assistant-acceptance-${runId}.json`;
let businessId;
let session;
let requestSequence = 0;
const turns = [];
const setupChanges = [];

function compactEntity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const fields = [
    "id", "name", "title", "phone", "rawPhone", "status", "customerId", "dueAt", "startsAt", "endsAt",
    "totalAmount", "paidAmount", "paymentStatus", "completedAt", "cancelledAt", "deletedAt", "mergedIntoCustomerId"
  ];
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}

async function request(method, path, body, { authenticated = true, idempotent = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (authenticated) headers.authorization = authorization;
  if (idempotent) headers["x-idempotency-key"] = `acceptance-${runId}-${++requestSequence}`;
  const response = await fetch(`${core}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(130_000)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function createSession(group) {
  const clientSessionId = `acceptance-${runId}-${group}`;
  const result = await request(
    "POST",
    `/v2/businesses/${businessId}/assistant/sessions`,
    { clientSessionId },
    { idempotent: true }
  );
  session = { id: result.session.id, clientSessionId };
}

async function batchDetails(actionBatchId) {
  if (!actionBatchId) return { mutations: [], pending: [], plan: undefined };
  const [batch, pending] = await Promise.all([
    prisma.actionBatch.findUnique({
      where: { id: actionBatchId },
      include: { mutations: { orderBy: { sequence: "asc" } }, steps: { orderBy: { createdAt: "asc" } } }
    }),
    prisma.aiPendingAction.findMany({ where: { actionBatchId }, orderBy: { createdAt: "asc" } })
  ]);
  return {
    plan: batch?.proposedPlan,
    mutations: (batch?.mutations ?? []).map((mutation) => ({
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      operation: mutation.operation,
      before: compactEntity(mutation.before),
      after: compactEntity(mutation.after)
    })),
    pending: pending.map((item) => ({
      id: item.id,
      actionType: item.actionType,
      status: item.status,
      question: item.question,
      missingFields: item.missingFields,
      requiresExplicitConfirmation: item.requiresExplicitConfirmation
    }))
  };
}

async function assistant(test, turn, transcript) {
  const startedAt = performance.now();
  try {
    const result = await request(
      "POST",
      `/v2/businesses/${businessId}/assistant/sessions/${session.id}/commands`,
      { clientSessionId: session.clientSessionId, transcript },
      { idempotent: true }
    );
    const totalDurationMs = Math.round(performance.now() - startedAt);
    const details = await batchDetails(result.actionBatch?.id);
    const record = {
      test,
      turn,
      transcript,
      httpStatus: 201,
      totalDurationMs,
      actionBatchId: result.actionBatch?.id,
      batchStatus: result.actionBatch?.status,
      response: result.receipt?.textSummary,
      voiceState: result.voiceResult?.state,
      steps: (result.receipt?.steps ?? []).map((step) => ({
        tool: step.tool,
        status: step.status,
        message: step.message,
        question: step.question,
        entityType: step.entityType,
        entityId: step.entityId,
        pendingActionId: step.pendingActionId
      })),
      ...details
    };
    turns.push(record);
    console.log(JSON.stringify({ test, turn, totalDurationMs, status: record.batchStatus, response: record.response }));
    return record;
  } catch (error) {
    const record = {
      test,
      turn,
      transcript,
      httpStatus: error.status ?? 0,
      totalDurationMs: Math.round(performance.now() - startedAt),
      error: error.body ?? error.message,
      mutations: [],
      pending: []
    };
    turns.push(record);
    console.log(JSON.stringify({ test, turn, totalDurationMs: record.totalDurationMs, httpStatus: record.httpStatus, error: record.error }));
    return record;
  }
}

function pendingId(record) {
  return record.pending.find((item) => item.status === "PENDING")?.id;
}

async function resolve(test, turn, source, transcript, payload = {}) {
  const id = pendingId(source);
  if (!id) {
    const record = { test, turn, transcript, route: "pending-resolve", httpStatus: 0, totalDurationMs: 0, error: "No pending action was produced", mutations: [], pending: [] };
    turns.push(record);
    return record;
  }
  const startedAt = performance.now();
  try {
    const result = await request("POST", `/v2/businesses/${businessId}/assistant/pending-actions/${id}/resolve`, { ...payload, confirmed: true }, { idempotent: true });
    const details = await batchDetails(result.actionBatchId);
    const record = {
      test,
      turn,
      transcript,
      route: "pending-resolve",
      httpStatus: 201,
      totalDurationMs: Math.round(performance.now() - startedAt),
      actionBatchId: result.actionBatchId,
      response: result.summary,
      ...details
    };
    turns.push(record);
    console.log(JSON.stringify({ test, turn, route: record.route, totalDurationMs: record.totalDurationMs, response: record.response }));
    return record;
  } catch (error) {
    const record = { test, turn, transcript, route: "pending-resolve", httpStatus: error.status ?? 0, totalDurationMs: Math.round(performance.now() - startedAt), error: error.body ?? error.message, mutations: [], pending: [] };
    turns.push(record);
    return record;
  }
}

async function reject(test, turn, source, transcript) {
  const id = pendingId(source);
  if (!id) {
    const record = { test, turn, transcript, route: "pending-reject", httpStatus: 0, totalDurationMs: 0, error: "No pending action was produced", mutations: [], pending: [] };
    turns.push(record);
    return record;
  }
  const startedAt = performance.now();
  try {
    const result = await request("POST", `/v2/businesses/${businessId}/assistant/pending-actions/${id}/reject`, {}, { idempotent: true });
    const details = await batchDetails(source.actionBatchId);
    const record = {
      test,
      turn,
      transcript,
      route: "pending-reject",
      httpStatus: 201,
      totalDurationMs: Math.round(performance.now() - startedAt),
      actionBatchId: source.actionBatchId,
      response: result.action?.status === "REJECTED" ? "הפעולה נדחתה." : "",
      ...details
    };
    turns.push(record);
    console.log(JSON.stringify({ test, turn, route: record.route, totalDurationMs: record.totalDurationMs, response: record.response }));
    return record;
  } catch (error) {
    const record = { test, turn, transcript, route: "pending-reject", httpStatus: error.status ?? 0, totalDurationMs: Math.round(performance.now() - startedAt), error: error.body ?? error.message, mutations: [], pending: [] };
    turns.push(record);
    return record;
  }
}

async function setupRequest(label, method, path, body) {
  const result = await request(method, path, body, { idempotent: true });
  setupChanges.push({ label, result: compactEntity(result.customer ?? result.task ?? result.job ?? result.visit ?? result.amount ?? result) });
  return result;
}

function dateTimeParts(date, timezone = "Asia/Jerusalem") {
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

function localDate(date) {
  const parts = dateTimeParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function localDateTimeToUtc(date, time, timezone = "Asia/Jerusalem") {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateTimeParts(candidate, timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate = new Date(candidate.getTime() + desired - represented);
  }
  return candidate.toISOString();
}

async function main() {
  const registration = await request("POST", "/auth/register-business", {
    firebaseUid,
    email: `assistant-acceptance-${runId}@example.com`,
    displayName: "בדיקות שיחת AI",
    businessName: `בדיקות שיחת AI ${runId}`
  }, { authenticated: false });
  businessId = registration.business.id;

  await createSession("a");
  await assistant(1, 1, "תוסיפי לי לקוח חדש בשם אורי לביא בדיקת קול");
  await assistant(2, 1, "תוסיפי לאורי לביא בדיקת קול טלפון 050-234-5678");
  await assistant(3, 1, "תעדכני את השם של אורי לביא בדיקת קול לאורי לביא לקוח בדיקה");
  await assistant(4, 1, "תוסיפי לי משימה לקנות מסנן חדש");
  await assistant(5, 1, "תזכירי לי להתקשר לאורי לביא לקוח בדיקה מחר בשעה תשע בבוקר");
  await assistant(6, 1, "תדחי את המשימה להתקשר לאורי לביא לקוח בדיקה למחר בשעה אחת עשרה בבוקר");
  await assistant(7, 1, "תסמני שהמשימה לקנות מסנן חדש הושלמה");
  await assistant(8, 1, "תקבעי לאורי לביא לקוח בדיקה עבודה בשם התקנת דוד מחר בשעה שתיים בצהריים");
  await assistant(9, 1, "תעבירי את העבודה התקנת דוד של אורי לביא לקוח בדיקה למחר בשעה ארבע אחר הצהריים");

  await createSession("b");
  await assistant(10, 1, "סיימתי את העבודה התקנת דוד אצל אורי לביא לקוח בדיקה");
  await assistant(11, 1, "לא היה חיוב");
  const visitWithAmount = await assistant(12, 1, "תקבעי לאורי לביא לקוח בדיקה ביקור בשם בדיקת נזילה מחרתיים בשעה אחת עשרה בבוקר, הסכום הוא שש מאות שקלים");
  await resolve(12, 2, visitWithAmount, "משתמש: לחיצה על אישור סכום");
  const payment = await assistant(13, 1, "אורי לביא לקוח בדיקה שילם מאתיים שקלים על הביקור בדיקת נזילה");
  await resolve(13, 2, payment, "משתמש: לחיצה על אישור תשלום");
  await assistant(14, 1, "כמה נשאר פתוח לתשלום?");
  const cancellation = await assistant(15, 1, "תבטלי את הביקור בדיקת נזילה של אורי לביא לקוח בדיקה");
  await resolve(15, 2, cancellation, "משתמש: לחיצה על אישור ביטול");

  await setupRequest("duplicate customer 1", "POST", `/v2/businesses/${businessId}/customers`, { name: "דנה כפולה" });
  await setupRequest("duplicate customer 2", "POST", `/v2/businesses/${businessId}/customers`, { name: "דנה כפולה" });
  await createSession("duplicate-customer");
  await assistant(16, 1, "תוסיפי לדנה כפולה משימה לחזור אליה מחר");

  await createSession("missing-customer-yes");
  await assistant(17, 1, "תזכירי לי להתקשר לרוני לקוח לא קיים מחר בשעה עשר");
  await assistant(17, 2, "כן, תיצרי אותו ותמשיכי");
  await createSession("missing-customer-no");
  await assistant(18, 1, "תזכירי לי להתקשר למיכל לקוחה לא קיימת מחר בשעה שתים עשרה");
  await assistant(18, 2, "לא, אל תיצרי אותה");

  await createSession("past-time");
  const nowParts = dateTimeParts(new Date());
  const pastHour = nowParts.hour > 0 ? nowParts.hour - 1 : 0;
  const pastTime = `${String(pastHour).padStart(2, "0")}:00`;
  await assistant(19, 1, `תקבעי לאורי לביא לקוח בדיקה ביקור בשם בדיקת עבר היום בשעה ${pastTime}`);

  const today = localDate(new Date());
  const dayAfterTomorrow = addDays(today, 2);
  const customer = await prisma.customer.findFirstOrThrow({ where: { businessId, name: "אורי לביא לקוח בדיקה", deletedAt: null } });
  await setupRequest("schedule conflict", "POST", `/v2/businesses/${businessId}/jobs`, {
    customerId: customer.id,
    title: "פעילות חוסמת",
    startsAt: localDateTimeToUtc(dayAfterTomorrow, "13:00"),
    endsAt: localDateTimeToUtc(dayAfterTomorrow, "14:00")
  });
  await createSession("schedule-conflict");
  await assistant(20, 1, "תקבעי לאורי לביא לקוח בדיקה ביקור בשם בדיקת לחץ מחרתיים באחת וחצי בצהריים");
  await assistant(20, 2, "כן, תקבעי בכל זאת");

  const balanceJob = await setupRequest("overpayment job", "POST", `/v2/businesses/${businessId}/jobs`, {
    customerId: customer.id,
    title: "בדיקת יתרה",
    startsAt: localDateTimeToUtc(addDays(today, 3), "10:00"),
    endsAt: localDateTimeToUtc(addDays(today, 3), "12:00")
  });
  await setupRequest("overpayment amount", "PUT", `/v2/businesses/${businessId}/jobs/${balanceJob.job.id}/amount`, {
    totalAmount: 500,
    currency: "ILS"
  });
  await setupRequest("overpayment paid", "POST", `/v2/businesses/${businessId}/jobs/${balanceJob.job.id}/amount/payments`, {
    mode: "ADD",
    amount: 300
  });
  await createSession("overpayment");
  await assistant(21, 1, "אורי לביא לקוח בדיקה שילם עוד שלוש מאות שקלים על העבודה בדיקת יתרה");

  await setupRequest("isolated delete task", "POST", `/v2/businesses/${businessId}/tasks`, {
    customerId: customer.id,
    title: "משימת מחיקה בדיקת קול"
  });
  await createSession("delete-and-undo");
  const deletion = await assistant(22, 1, "תמחקי את המשימה משימת מחיקה בדיקת קול של אורי לביא לקוח בדיקה");
  await resolve(22, 2, deletion, "משתמש: לחיצה על אישור מחיקה");
  const undo = await assistant(23, 1, "תבטלי את הפעולה האחרונה ותחזירי את המשימה");
  await resolve(23, 2, undo, "משתמש: לחיצה על אישור Undo");
  await createSession("dependent-creation");
  await assistant(24, 1, "תוסיפי לקוחה חדשה בשם יעל שלו בדיקת קול ותקבעי אצלה עבודה בשם החלפת ברז מחר בשעה שתיים בצהריים");
  await createSession("unclear");
  await assistant(25, 1, "תעשי עם זה משהו מחר");

  await setupRequest("declined cancellation visit", "POST", `/v2/businesses/${businessId}/visits`, {
    customerId: customer.id,
    title: "ביקור ביטול שנדחה"
  });
  await createSession("decline-cancel");
  const declineCancel = await assistant(26, 1, "תבטלי את הביקור ביקור ביטול שנדחה של אורי לביא לקוח בדיקה");
  await reject(26, 2, declineCancel, "משתמש: לא לאשר ביטול");

  const declinePaymentJob = await setupRequest("declined payment job", "POST", `/v2/businesses/${businessId}/jobs`, {
    customerId: customer.id,
    title: "עבודת תשלום שנדחה"
  });
  await setupRequest("declined payment amount", "PUT", `/v2/businesses/${businessId}/jobs/${declinePaymentJob.job.id}/amount`, { totalAmount: 100 });
  await createSession("decline-payment");
  const declinePayment = await assistant(27, 1, "אורי לביא לקוח בדיקה שילם חמישים שקלים על העבודה עבודת תשלום שנדחה");
  await reject(27, 2, declinePayment, "משתמש: לא לאשר תשלום");

  await setupRequest("declined deletion task", "POST", `/v2/businesses/${businessId}/tasks`, {
    customerId: customer.id,
    title: "משימת מחיקה שנדחתה"
  });
  await createSession("decline-delete");
  const declineDelete = await assistant(28, 1, "תמחקי את המשימה משימת מחיקה שנדחתה של אורי לביא לקוח בדיקה");
  await reject(28, 2, declineDelete, "משתמש: לא לאשר מחיקה");

  await createSession("decline-undo");
  await assistant(29, 1, "תוסיפי לי משימה בדיקת Undo שנדחה");
  const declineUndo = await assistant(29, 2, "תבטלי את הפעולה האחרונה");
  await reject(29, 3, declineUndo, "משתמש: לא לאשר Undo");

  const finalState = {
    customers: await prisma.customer.findMany({ where: { businessId }, select: { id: true, name: true, deletedAt: true }, orderBy: { createdAt: "asc" } }),
    tasks: await prisma.task.findMany({ where: { businessId }, select: { id: true, customerId: true, title: true, status: true, dueAt: true, deletedAt: true }, orderBy: { createdAt: "asc" } }),
    jobs: await prisma.job.findMany({ where: { businessId }, select: { id: true, customerId: true, title: true, status: true, startsAt: true, endsAt: true, deletedAt: true }, orderBy: { createdAt: "asc" } }),
    visits: await prisma.visit.findMany({ where: { businessId }, select: { id: true, customerId: true, title: true, status: true, startsAt: true, endsAt: true, deletedAt: true }, orderBy: { createdAt: "asc" } }),
    pendingActions: await prisma.aiPendingAction.findMany({ where: { businessId }, select: { id: true, assistantSessionId: true, actionType: true, status: true, question: true }, orderBy: { createdAt: "asc" } })
  };
  const report = {
    runId,
    startedForBusiness: businessId,
    firebaseUid,
    reportPath,
    scope: "Approved transcripts sent to Core; microphone/PTT/STT not exercised",
    setupChanges,
    turns,
    finalState
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ complete: true, reportPath, businessId, turnCount: turns.length, scenarioCount: 29 }));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
