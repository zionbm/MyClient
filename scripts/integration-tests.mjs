import { assert, request } from "./http.mjs";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const telephony = process.env.TELEPHONY_BASE_URL ?? "http://localhost:3003";
const suffix = Date.now().toString();
const firebaseUid = `firebase_it_${suffix}`;
const token = `Bearer mock:${firebaseUid}`;

function expectStatus(result, expected, label) {
  assert(result.status === expected, `${label}: expected ${expected}, got ${result.status}`, result.body);
}

expectStatus(request("GET", `${core}/health`), 200, "core health");

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
  phone: "+972502222222"
}, { authorization: token });
expectStatus(customerResult, 201, "create customer");
const customerId = customerResult.body.customer.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/appointments`, {
  customerId,
  title: "פגישת אינטגרציה",
  startsAt: "2026-08-21T09:00:00.000Z"
}, { authorization: token }), 201, "create appointment");

expectStatus(request("POST", `${core}/businesses/${businessId}/jobs`, {
  customerId,
  title: "עבודת אינטגרציה"
}, { authorization: token }), 201, "create job");

const aiPending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "CREATE_TASK",
    idempotencyKey: `it_pending_${suffix}`,
    confidence: 0.7,
    requiresConfirmation: false,
    missingFields: ["title"],
    payload: {}
  }
}, { authorization: token });
expectStatus(aiPending, 201, "create pending action");
const pendingActionId = aiPending.body.pending.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/pending-actions/${pendingActionId}/complete`, {
  payload: { title: "משימה מפעולה ממתינה" }
}, { authorization: token }), 201, "complete pending action");

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

const notifications = request("GET", `${core}/businesses/${businessId}/notifications?status=PENDING`, undefined, { authorization: token });
expectStatus(notifications, 200, "list notifications");
assert(notifications.body.notifications.length > 0, "expected at least one pending notification");
const notificationId = notifications.body.notifications[0].id;

expectStatus(request("PATCH", `${core}/businesses/${businessId}/notifications/${notificationId}`, {
  status: "READ"
}, { authorization: token }), 200, "mark notification read");

const calls = request("GET", `${core}/businesses/${businessId}/calls`, undefined, { authorization: token });
expectStatus(calls, 200, "list calls");
assert(calls.body.calls.some((call) => call.transcripts.length > 0), "expected a call transcript");

const audit = request("GET", `${core}/businesses/${businessId}/audit-events`, undefined, { authorization: token });
expectStatus(audit, 200, "list audit");
assert(audit.body.auditEvents.length > 0, "expected audit events");

console.log(JSON.stringify({ ok: true, businessId, firebaseUid, phoneNumber }, null, 2));
