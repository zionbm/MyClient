import { assert, request } from "./http.mjs";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const ai = process.env.AI_BASE_URL ?? "http://localhost:3001";
const voice = process.env.VOICE_BASE_URL ?? "http://localhost:3002";
const telephony = process.env.TELEPHONY_BASE_URL ?? "http://localhost:3003";
const worker = process.env.WORKER_BASE_URL ?? "http://localhost:3004";
const suffix = Date.now().toString();
const firebaseUid = `firebase_it_${suffix}`;
const token = `Bearer mock:${firebaseUid}`;

function expectStatus(result, expected, label) {
  assert(result.status === expected, `${label}: expected ${expected}, got ${result.status}`, result.body);
}

expectStatus(request("GET", `${core}/health`), 200, "core health");
expectStatus(request("POST", `${ai}/intent/parse`, { text: "בדיקה" }), 401, "AI internal auth rejected");
expectStatus(request("POST", `${voice}/stt/mock`, { transcript: "בדיקה" }), 401, "Voice internal auth rejected");
expectStatus(request("GET", `${worker}/reminders/status`), 401, "Worker internal auth rejected");

const registration = request("POST", `${core}/auth/register-business`, {
  firebaseUid,
  email: `integration-${suffix}@example.com`,
  displayName: "בודק אינטגרציה",
  businessName: "עסק אינטגרציה"
});
expectStatus(registration, 201, "register business");
const businessId = registration.body.business.id;

expectStatus(request("GET", `${core}/businesses/${businessId}/customers`), 401, "missing auth rejected");

const settings = request("PATCH", `${core}/businesses/${businessId}/settings`, {
  notificationPhone: "+972501234567",
  greetingText: "שלום, הגעתם לעסק אינטגרציה. לחזרה 1, הודעה 2, דחוף 3."
}, { authorization: token });
expectStatus(settings, 200, "update settings");

const phoneNumber = `+9723999${suffix.slice(-4).padStart(4, "0")}`;
expectStatus(request("POST", `${core}/businesses/${businessId}/phone-numbers`, {
  plivoNumber: phoneNumber,
  displayName: "בדיקת אינטגרציה"
}, { authorization: token }), 201, "create phone number");

const customerResult = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "לקוח אינטגרציה",
  phone: "+972502222222",
  initialNote: "הערה ראשונית"
}, { authorization: token });
expectStatus(customerResult, 201, "create customer");
const customerId = customerResult.body.customer.id;
assert(customerResult.body.initialNote, "expected initial note");

const secondCustomerResult = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "לקוח אינטגרציה שני",
  phone: "+972502222223"
}, { authorization: token });
expectStatus(secondCustomerResult, 201, "create second customer");

const firstCustomersPage = request("GET", `${core}/businesses/${businessId}/customers?limit=1`, undefined, { authorization: token });
expectStatus(firstCustomersPage, 200, "list customers first page");
assert(firstCustomersPage.body.customers.length === 1, "expected one customer in first page", firstCustomersPage.body);
assert(firstCustomersPage.body.pageInfo?.hasMore === true, "expected customer pageInfo.hasMore");
assert(firstCustomersPage.body.pageInfo?.nextCursor, "expected customer nextCursor");
const secondCustomersPage = request(
  "GET",
  `${core}/businesses/${businessId}/customers?limit=1&cursor=${encodeURIComponent(firstCustomersPage.body.pageInfo.nextCursor)}`,
  undefined,
  { authorization: token }
);
expectStatus(secondCustomersPage, 200, "list customers second page");
assert(secondCustomersPage.body.customers.length === 1, "expected one customer in second page", secondCustomersPage.body);
assert(secondCustomersPage.body.customers[0].id !== firstCustomersPage.body.customers[0].id, "expected no duplicate customer across pages");

expectStatus(request("POST", `${core}/businesses/${businessId}/members`, {
  phoneNumber: `+972555${suffix.slice(-6).padStart(6, "0")}`
}, { authorization: token }), 201, "create pending member");

const members = request("GET", `${core}/businesses/${businessId}/members`, undefined, { authorization: token });
expectStatus(members, 200, "list members");
assert(members.body.members.length > 0, "expected business members");

const appointmentResult = request("POST", `${core}/businesses/${businessId}/appointments`, {
  customerId,
  title: "פגישת אינטגרציה",
  startsAt: "2026-08-21T09:00:00.000Z"
}, { authorization: token });
expectStatus(appointmentResult, 201, "create appointment");
const appointmentId = appointmentResult.body.appointment.id;

const reminderResult = request("POST", `${core}/businesses/${businessId}/reminders`, {
  customerId,
  title: "לחזור ללקוח אינטגרציה",
  dueAt: "2026-08-21T10:00:00.000Z"
}, { authorization: token });
expectStatus(reminderResult, 201, "create reminder");
const reminderId = reminderResult.body.reminder.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/home-visits`, {
  customerId,
  title: "ביקור בית אינטגרציה",
  startsAt: "2026-08-21T11:00:00.000Z",
  location: "רחוב בדיקה 1"
}, { authorization: token }), 201, "create home visit");

const quoteResult = request("POST", `${core}/businesses/${businessId}/quotes`, {
  customerId,
  title: "הצעת מחיר אינטגרציה",
  dueAt: "2026-08-21T12:00:00.000Z",
  estimatedAmount: "250"
}, { authorization: token });
expectStatus(quoteResult, 201, "create quote");
const quoteId = quoteResult.body.quote.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/quotes/${quoteId}/mark-paid`, undefined, { authorization: token }), 201, "mark quote paid");

const home = request("GET", `${core}/businesses/${businessId}/home?date=2026-08-21`, undefined, { authorization: token });
expectStatus(home, 200, "home work items");
assert(home.body.items.some((item) => item.type === "reminder"), "expected reminder home item");
assert(home.body.items.some((item) => item.type === "home_visit"), "expected home visit home item");
assert(home.body.items.some((item) => item.type === "appointment"), "expected appointment home item");
assert(home.body.items.some((item) => item.type === "quote"), "expected quote home item");

const customerDetail = request("GET", `${core}/businesses/${businessId}/customers/${customerId}`, undefined, { authorization: token });
expectStatus(customerDetail, 200, "customer detail activity");
assert(customerDetail.body.activity.some((item) => item.type === "reminder"), "expected customer reminder activity");
assert(customerDetail.body.activity.some((item) => item.type === "home_visit"), "expected customer home visit activity");
assert(customerDetail.body.activity.some((item) => item.type === "quote"), "expected customer quote activity");
assert(customerDetail.body.activity.some((item) => item.type === "note"), "expected customer note activity");
const noteId = customerDetail.body.activity.find((item) => item.type === "note").id;

const aiPending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "CREATE_REMINDER",
    idempotencyKey: `it_pending_${suffix}`,
    confidence: 0.7,
    requiresConfirmation: false,
    missingFields: ["title"],
    payload: {}
  }
}, { authorization: token });
expectStatus(aiPending, 201, "create AI pending action");
const aiPendingActionId = aiPending.body.aiPendingAction.id;

expectStatus(request("PATCH", `${core}/businesses/${businessId}/ai-pending-actions/${aiPendingActionId}`, {
  reviewReason: "בדיקת עריכה"
}, { authorization: token }), 200, "edit AI pending action");

expectStatus(request("POST", `${core}/businesses/${businessId}/ai-pending-actions/${aiPendingActionId}/approve`, {
  payload: { title: "משימה מפעולה ממתינה" }
}, { authorization: token }), 201, "approve AI pending action");
expectStatus(request("POST", `${core}/businesses/${businessId}/ai-pending-actions/${aiPendingActionId}/approve`, {
  payload: { title: "לא אמור להתבצע שוב" }
}, { authorization: token }), 400, "reject duplicate AI pending approval");

const deleteNotePending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "DELETE_WORK_ITEM",
    idempotencyKey: `it_delete_note_${suffix}`,
    confidence: 0.7,
    requiresConfirmation: false,
    missingFields: ["itemId"],
    payload: { itemType: "note" }
  }
}, { authorization: token });
expectStatus(deleteNotePending, 201, "create delete note pending action");

expectStatus(request("POST", `${core}/businesses/${businessId}/ai-pending-actions/${deleteNotePending.body.aiPendingAction.id}/approve`, {
  payload: { itemId: noteId }
}, { authorization: token }), 201, "approve delete note work item");

expectStatus(request("DELETE", `${core}/businesses/${businessId}/appointments/${appointmentId}`, undefined, { authorization: token }), 200, "delete appointment");

expectStatus(request("POST", `${telephony}/plivo/incoming`, {
  callId: `it_call_${suffix}`,
  from: "+972503333333",
  to: phoneNumber
}), 201, "incoming call menu");

expectStatus(request("POST", `${telephony}/plivo/recording`, {
  callId: `it_call_${suffix}`,
  from: "+972503333333",
  to: phoneNumber,
  transcript: "צריך חזרה דחופה",
  urgent: true,
  recordingUrl: `mock://recording/it_call_${suffix}`
}), 201, "recording flow");

const notifications = request("GET", `${core}/businesses/${businessId}/notifications`, undefined, { authorization: token });
expectStatus(notifications, 200, "list notifications");
assert(notifications.body.notifications.length > 0, "expected at least one notification");
assert(notifications.body.pageInfo, "expected notifications pageInfo");
const notificationId = notifications.body.notifications[0].id;

expectStatus(request("POST", `${core}/businesses/${businessId}/notifications/${notificationId}/snooze`, {
  preset: "IN_15_MINUTES"
}, { authorization: token }), 201, "snooze notification");

const reminderNotification = request("POST", `${core}/businesses/${businessId}/notifications/${notificationId}/read`, undefined, { authorization: token });
expectStatus(reminderNotification, 201, "mark notification read");

expectStatus(request("POST", `${core}/businesses/${businessId}/reminders/${reminderId}/complete`, undefined, { authorization: token }), 201, "complete reminder");

const calls = request("GET", `${core}/businesses/${businessId}/calls`, undefined, { authorization: token });
expectStatus(calls, 200, "list calls");
assert(calls.body.calls.some((call) => call.transcriptPreview), "expected a call transcript preview");
assert(calls.body.calls.some((call) => call.ivrSelection && call.displayStatus), "expected product-shaped call display state");
assert(calls.body.pageInfo, "expected calls pageInfo");

const audit = request("GET", `${core}/businesses/${businessId}/audit-events`, undefined, { authorization: token });
expectStatus(audit, 200, "list audit");
assert(audit.body.auditEvents.length > 0, "expected audit events");
assert(audit.body.pageInfo, "expected audit pageInfo");

console.log(JSON.stringify({ ok: true, businessId, firebaseUid, phoneNumber }, null, 2));
