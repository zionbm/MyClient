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
  phoneNumber: `+972544${suffix.slice(-6).padStart(6, "0")}`,
  displayName: "בודק אינטגרציה",
  businessName: "עסק אינטגרציה"
});
expectStatus(registration, 201, "register business");
const businessId = registration.body.business.id;

expectStatus(request("GET", `${core}/businesses/${businessId}/customers`), 401, "missing auth rejected");

const otherFirebaseUid = `firebase_it_other_${suffix}`;
const otherRegistration = request("POST", `${core}/auth/register-business`, {
  firebaseUid: otherFirebaseUid,
  email: `integration-other-${suffix}@example.com`,
  displayName: "בודק אינטגרציה אחר",
  businessName: "עסק אינטגרציה אחר"
});
expectStatus(otherRegistration, 201, "register other business");
const otherBusinessId = otherRegistration.body.business.id;
expectStatus(request("GET", `${core}/businesses/${otherBusinessId}/customers`, undefined, { authorization: token }), 403, "cross-business customer list rejected");

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

const yoavCustomerResult = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "יואב גת",
  phone: "+972502222224"
}, { authorization: token });
expectStatus(yoavCustomerResult, 201, "create Yoav customer for voice matching");
const yoavCustomerId = yoavCustomerResult.body.customer.id;

const jerryCustomerResult = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "ג׳רי",
  phone: "+972502222225"
}, { authorization: token });
expectStatus(jerryCustomerResult, 201, "create Jerry customer for voice matching");
const jerryCustomerId = jerryCustomerResult.body.customer.id;

const mosheCustomerResult = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "משה",
  phone: "+972502222226"
}, { authorization: token });
expectStatus(mosheCustomerResult, 201, "create Moshe customer for voice matching");
const mosheCustomerId = mosheCustomerResult.body.customer.id;

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
const ownerMember = members.body.members.find((member) => member.memberType === "OWNER");
const employeeMember = members.body.members.find((member) => member.memberType === "EMPLOYEE");
assert(ownerMember, "expected owner business member");
assert(employeeMember, "expected employee business member");
expectStatus(
  request("POST", `${core}/businesses/${businessId}/members/${ownerMember.id}/disable`, {}, { authorization: token }),
  403,
  "disable business owner rejected"
);
expectStatus(
  request("POST", `${core}/businesses/${businessId}/members`, {
    phoneNumber: ownerMember.phoneNumber,
    memberType: "EMPLOYEE"
  }, { authorization: token }),
  403,
  "changing business owner membership rejected"
);
expectStatus(
  request("POST", `${core}/businesses/${businessId}/members`, {
    phoneNumber: `+972533${suffix.slice(-6).padStart(6, "0")}`,
    memberType: "OWNER"
  }, { authorization: token }),
  400,
  "creating another business owner rejected"
);
expectStatus(
  request("POST", `${core}/businesses/${businessId}/members/${employeeMember.id}/disable`, {}, { authorization: token }),
  201,
  "disable employee member"
);

const appointmentResult = request("POST", `${core}/businesses/${businessId}/appointments`, {
  customerId,
  title: "פגישת אינטגרציה",
  startsAt: "2026-08-21T09:00:00.000Z"
}, { authorization: token });
expectStatus(appointmentResult, 201, "create appointment");
const appointmentId = appointmentResult.body.appointment.id;

const yoavAppointmentResult = request("POST", `${core}/businesses/${businessId}/appointments`, {
  customerId: yoavCustomerId,
  title: "פגישה עם יואב גת",
  startsAt: "2026-08-21T09:30:00.000Z"
}, { authorization: token });
expectStatus(yoavAppointmentResult, 201, "create Yoav appointment for voice matching");
const yoavAppointmentId = yoavAppointmentResult.body.appointment.id;

const completeYoavAppointmentPending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "COMPLETE_APPOINTMENT",
    idempotencyKey: `it_complete_yoav_${suffix}`,
    confidence: 0.95,
    requiresConfirmation: false,
    missingFields: ["appointmentId"],
    payload: { customerName: "יואב גת" }
  }
}, { authorization: token });
expectStatus(completeYoavAppointmentPending, 201, "create complete Yoav appointment pending action");
const completeYoavAppointmentResult = request(
  "POST",
  `${core}/businesses/${businessId}/ai-pending-actions/${completeYoavAppointmentPending.body.aiPendingAction.id}/approve`,
  {},
  { authorization: token }
);
expectStatus(completeYoavAppointmentResult, 201, "resolve and complete Yoav appointment");
assert(completeYoavAppointmentResult.body.execution.appointment.id === yoavAppointmentId, "expected matching Yoav appointment");
assert(completeYoavAppointmentResult.body.execution.appointment.status === "DONE", "expected Yoav appointment to be done");

const createJerryReminderPending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "CREATE_REMINDER",
    idempotencyKey: `it_remind_jerry_${suffix}`,
    confidence: 0.95,
    requiresConfirmation: false,
    missingFields: ["customerId"],
    payload: {
      title: "להתקשר לג'רי",
      customerName: "ג'רי",
      dueAt: "2026-08-21T10:10:00.000Z"
    }
  }
}, { authorization: token });
expectStatus(createJerryReminderPending, 201, "create Jerry reminder pending action");
const createJerryReminderResult = request(
  "POST",
  `${core}/businesses/${businessId}/ai-pending-actions/${createJerryReminderPending.body.aiPendingAction.id}/approve`,
  {},
  { authorization: token }
);
expectStatus(createJerryReminderResult, 201, "resolve Jerry and create reminder");
assert(createJerryReminderResult.body.execution.reminder.customerId === jerryCustomerId, "expected reminder linked to Jerry customer");

const reminderResult = request("POST", `${core}/businesses/${businessId}/reminders`, {
  customerId,
  title: "לחזור ללקוח אינטגרציה",
  dueAt: "2026-08-21T10:00:00.000Z"
}, { authorization: token });
expectStatus(reminderResult, 201, "create reminder");
const reminderId = reminderResult.body.reminder.id;

const dueReminderResult = request("POST", `${core}/businesses/${businessId}/reminders`, {
  customerId,
  title: `תזכורת due יחידה ${suffix}`,
  dueAt: "2026-08-21T10:30:00.000Z"
}, { authorization: token });
expectStatus(dueReminderResult, 201, "create due reminder");
const dueReminderId = dueReminderResult.body.reminder.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/home-visits`, {
  customerId,
  title: "ביקור בית אינטגרציה",
  startsAt: "2026-08-21T11:00:00.000Z",
  location: "רחוב בדיקה 1"
}, { authorization: token }), 201, "create home visit");

const mosheHomeVisitResult = request("POST", `${core}/businesses/${businessId}/home-visits`, {
  customerId: mosheCustomerId,
  title: "ביקור בית אצל משה",
  startsAt: "2026-08-21T11:30:00.000Z",
  location: "רחוב הדוגמה 2"
}, { authorization: token });
expectStatus(mosheHomeVisitResult, 201, "create Moshe home visit for voice matching");
const mosheHomeVisitId = mosheHomeVisitResult.body.homeVisit.id;

const completeMosheVisitPending = request("POST", `${core}/owner-actions/execute`, {
  businessId,
  action: {
    type: "COMPLETE_HOME_VISIT",
    idempotencyKey: `it_complete_moshe_${suffix}`,
    confidence: 0.95,
    requiresConfirmation: false,
    missingFields: ["homeVisitId"],
    payload: { customerName: "משה" }
  }
}, { authorization: token });
expectStatus(completeMosheVisitPending, 201, "create complete Moshe home visit pending action");
const completeMosheVisitResult = request(
  "POST",
  `${core}/businesses/${businessId}/ai-pending-actions/${completeMosheVisitPending.body.aiPendingAction.id}/approve`,
  {},
  { authorization: token }
);
expectStatus(completeMosheVisitResult, 201, "resolve and complete Moshe home visit");
assert(completeMosheVisitResult.body.execution.homeVisit.id === mosheHomeVisitId, "expected matching Moshe home visit");
assert(completeMosheVisitResult.body.execution.homeVisit.status === "DONE", "expected Moshe home visit to be done");

const quoteResult = request("POST", `${core}/businesses/${businessId}/quotes`, {
  customerId,
  title: "הצעת מחיר אינטגרציה",
  dueAt: "2026-08-21T12:00:00.000Z",
  estimatedAmount: "250"
}, { authorization: token });
expectStatus(quoteResult, 201, "create quote");
const quoteId = quoteResult.body.quote.id;

expectStatus(request("POST", `${core}/businesses/${businessId}/quotes/${quoteId}/mark-paid`, undefined, { authorization: token }), 201, "mark quote paid");

for (const [itemType, itemId, expectedTitle] of [
  ["reminder", reminderId, "לחזור ללקוח אינטגרציה"],
  ["appointment", appointmentId, "פגישת אינטגרציה"],
  ["home_visit", mosheHomeVisitId, "ביקור בית אצל משה"],
  ["quote", quoteId, "הצעת מחיר אינטגרציה"]
]) {
  const result = request(
    "GET",
    `${core}/businesses/${businessId}/work-items/${itemType}/${itemId}`,
    undefined,
    { authorization: token }
  );
  expectStatus(result, 200, `get linked ${itemType} work item`);
  assert(result.body.item.type === itemType, `expected ${itemType} work item type`, result.body);
  assert(result.body.item.title === expectedTitle, `expected ${itemType} title`, result.body);
  assert(result.body.item.customer?.id, `expected ${itemType} customer context`, result.body);
}
expectStatus(
  request("GET", `${core}/businesses/${otherBusinessId}/work-items/reminder/${reminderId}`, undefined, { authorization: token }),
  403,
  "cross-business linked work item rejected"
);
expectStatus(
  request("GET", `${core}/businesses/${businessId}/work-items/unknown/${reminderId}`, undefined, { authorization: token }),
  404,
  "unknown linked work item type rejected"
);

for (const [label, path, collection] of [
  ["reminders", "reminders", "reminders"],
  ["appointments", "appointments", "appointments"],
  ["home visits", "home-visits", "homeVisits"],
  ["quotes", "quotes", "quotes"]
]) {
  const result = request("GET", `${core}/businesses/${businessId}/${path}?limit=1`, undefined, { authorization: token });
  expectStatus(result, 200, `list ${label} with pagination`);
  assert(Array.isArray(result.body[collection]), `expected ${label} collection`);
  assert(result.body.pageInfo, `expected ${label} pageInfo`);
}

expectStatus(request("GET", `${core}/businesses/${businessId}/notifications?status=NOPE`, undefined, { authorization: token }), 400, "invalid notification status rejected");
expectStatus(request("GET", `${core}/businesses/${businessId}/ai-pending-actions?status=NOPE`, undefined, { authorization: token }), 400, "invalid AI pending action status rejected");

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

expectStatus(request("POST", `${core}/internal/reminders/due`, { limit: 100 }, { "x-internal-secret": "dev-internal-secret" }), 201, "process due reminders first run");
expectStatus(request("POST", `${core}/internal/reminders/due`, { limit: 100 }, { "x-internal-secret": "dev-internal-secret" }), 201, "process due reminders second run");

const calls = request("GET", `${core}/businesses/${businessId}/calls`, undefined, { authorization: token });
expectStatus(calls, 200, "list calls");
assert(calls.body.calls.some((call) => call.transcriptPreview), "expected a call transcript preview");
assert(calls.body.calls.some((call) => call.ivrSelection && call.displayStatus), "expected product-shaped call display state");
assert(calls.body.pageInfo, "expected calls pageInfo");

const audit = request("GET", `${core}/businesses/${businessId}/audit-events`, undefined, { authorization: token });
expectStatus(audit, 200, "list audit");
assert(audit.body.auditEvents.length > 0, "expected audit events");
assert(audit.body.pageInfo, "expected audit pageInfo");

const dueNotifications = request("GET", `${core}/businesses/${businessId}/notifications`, undefined, { authorization: token });
expectStatus(dueNotifications, 200, "list notifications after due processing");
const matchingDueNotifications = dueNotifications.body.notifications.filter((notification) => notification.reminderId === dueReminderId);
assert(matchingDueNotifications.length === 1, "expected exactly one notification for claimed due reminder", matchingDueNotifications);

console.log(JSON.stringify({ ok: true, businessId, firebaseUid, phoneNumber }, null, 2));
