import { request } from "./http.mjs";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const suffix = process.env.SEED_SUFFIX ?? Date.now().toString();
const firebaseUid = `firebase_demo_${suffix}`;
const token = `Bearer mock:${firebaseUid}`;
const auth = (key) => ({ authorization: token, "x-idempotency-key": `${key}-${suffix}` });

const registration = request("POST", `${core}/auth/register-business`, {
  firebaseUid,
  email: `demo-${suffix}@example.com`,
  displayName: "דמו בעל עסק",
  businessName: "דמו תיקונים"
});
const businessId = registration.body.business.id;

request("PATCH", `${core}/businesses/${businessId}/settings`, {
  notificationPhone: "+972501111111",
  greetingText: "שלום, הגעתם לדמו תיקונים. לחזרה הקישו 1, הודעה 2, דחוף 3."
}, { authorization: token });

const phoneNumber = `+9723000${suffix.slice(-4).padStart(4, "0")}`;
request("POST", `${core}/businesses/${businessId}/phone-numbers`, {
  plivoNumber: phoneNumber,
  displayName: "מספר דמו"
}, { authorization: token });

const customer = request("POST", `${core}/v2/businesses/${businessId}/customers`, {
  name: "לקוח דמו",
  generalNotes: "לקוח לדוגמה"
}, auth("customer")).body.customer;

request("POST", `${core}/v2/businesses/${businessId}/customers/${customer.id}/phones`, {
  phone: "+972502222222",
  isPrimary: true
}, auth("customer-phone"));

const serviceAddress = request("POST", `${core}/v2/businesses/${businessId}/customers/${customer.id}/addresses`, {
  label: "בית",
  addressText: "הרצל 10, תל אביב"
}, auth("service-address")).body.address;

request("POST", `${core}/v2/businesses/${businessId}/tasks`, {
  customerId: customer.id,
  title: "לחזור ללקוח הדמו",
  dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
}, auth("task"));

const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
startsAt.setUTCHours(8, 0, 0, 0);
request("POST", `${core}/v2/businesses/${businessId}/visits`, {
  customerId: customer.id,
  title: "ביקור דמו",
  startsAt: startsAt.toISOString(),
  endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
  serviceAddressId: serviceAddress.id
}, auth("visit"));

console.log(JSON.stringify({ businessId, firebaseUid, token, phoneNumber, customerId: customer.id }, null, 2));
