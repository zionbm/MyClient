import { request } from "./http.mjs";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const telephony = process.env.TELEPHONY_BASE_URL ?? "http://localhost:3003";
const suffix = process.env.SEED_SUFFIX ?? Date.now().toString();
const firebaseUid = `firebase_demo_${suffix}`;
const token = `Bearer mock:${firebaseUid}`;

const businessRegistration = request("POST", `${core}/auth/register-business`, {
  firebaseUid,
  email: `demo-${suffix}@example.com`,
  displayName: "דמו בעל עסק",
  businessName: "דמו תיקונים"
});

const businessId = businessRegistration.body.business.id;

request("PATCH", `${core}/businesses/${businessId}/settings`, {
  notificationPhone: "+972501111111",
  greetingText: "שלום, הגעתם לדמו תיקונים. לחזרה הקישו 1, הודעה 2, דחוף 3."
}, { authorization: token });

const phoneNumber = `+9723000${suffix.slice(-4).padStart(4, "0")}`;
request("POST", `${core}/businesses/${businessId}/phone-numbers`, {
  plivoNumber: phoneNumber,
  displayName: "מספר דמו"
}, { authorization: token });

const customer = request("POST", `${core}/businesses/${businessId}/customers`, {
  name: "לקוח דמו",
  phone: "+972502222222",
  address: "הרצל 10, תל אביב"
}, { authorization: token }).body.customer;

request("POST", `${core}/businesses/${businessId}/appointments`, {
  customerId: customer.id,
  title: "פגישת דמו",
  startsAt: "2026-08-21T09:00:00.000Z",
  endsAt: "2026-08-21T10:00:00.000Z"
}, { authorization: token });

request("POST", `${core}/businesses/${businessId}/home-visits`, {
  customerId: customer.id,
  title: "ביקור בית דמו",
  location: "הרצל 10, תל אביב",
  notes: "בדיקת מזגן",
  startsAt: "2026-08-21T11:00:00.000Z"
}, { authorization: token });

request("POST", `${telephony}/plivo/recording`, {
  callId: `demo_call_${suffix}`,
  from: "+972503333333",
  to: phoneNumber,
  transcript: "אשמח שתחזרו אליי לגבי התקלה",
  urgent: true,
  recordingUrl: `mock://recording/demo_call_${suffix}`
});

console.log(JSON.stringify({
  businessId,
  firebaseUid,
  token,
  phoneNumber,
  customerId: customer.id
}, null, 2));
