import { assert, request } from "./http.mjs";

const core = process.env.CORE_BASE_URL ?? "http://localhost:3000";
const ai = process.env.AI_BASE_URL ?? "http://localhost:3001";
const worker = process.env.WORKER_BASE_URL ?? "http://localhost:3004";
const suffix = Date.now().toString();
const firebaseUid = `firebase_it_${suffix}`;
const token = `Bearer mock:${firebaseUid}`;

function expectStatus(result, expected, label) {
  assert(result.status === expected, `${label}: expected ${expected}, got ${result.status}`, result.body);
}

function authHeaders(idempotencyKey) {
  return { authorization: token, ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}) };
}

expectStatus(request("GET", `${core}/health`), 200, "core health");
expectStatus(request("POST", `${ai}/v2/assistant/plan`, { transcript: "בדיקה" }), 401, "AI internal auth rejected");
expectStatus(request("GET", `${worker}/tasks/status`), 401, "worker internal auth rejected");

const registration = request("POST", `${core}/auth/register-business`, {
  firebaseUid,
  email: `integration-${suffix}@example.com`,
  displayName: "בודק אינטגרציה",
  businessName: "עסק אינטגרציה"
});
expectStatus(registration, 201, "register business");
const businessId = registration.body.business.id;

expectStatus(request("GET", `${core}/v2/businesses/${businessId}/customers`), 401, "missing auth rejected");

const customerResult = request("POST", `${core}/v2/businesses/${businessId}/customers`, {
  name: "לקוח אינטגרציה",
  email: `customer-${suffix}@example.com`,
  generalNotes: "לקוח שנוצר בבדיקת V2"
}, authHeaders(`customer-${suffix}`));
expectStatus(customerResult, 201, "create customer");
const customerId = customerResult.body.customer.id;

expectStatus(request("POST", `${core}/v2/businesses/${businessId}/customers/${customerId}/phones`, {
  phone: "+972502222222",
  isPrimary: true
}, authHeaders(`phone-${suffix}`)), 201, "create customer phone");

const addressResult = request("POST", `${core}/v2/businesses/${businessId}/customers/${customerId}/addresses`, {
  label: "בית",
  addressText: "הרצל 10, תל אביב"
}, authHeaders(`address-${suffix}`));
expectStatus(addressResult, 201, "create service address");

const taskResult = request("POST", `${core}/v2/businesses/${businessId}/tasks`, {
  customerId,
  title: "לחזור ללקוח",
  dueAt: new Date(Date.now() - 60_000).toISOString()
}, authHeaders(`task-${suffix}`));
expectStatus(taskResult, 201, "create task");
const taskId = taskResult.body.task.id;
expectStatus(request("POST", `${core}/v2/businesses/${businessId}/tasks/${taskId}/complete`, {}, authHeaders(`task-complete-${suffix}`)), 201, "complete task");

const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
startsAt.setUTCHours(8, 0, 0, 0);
const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
const jobResult = request("POST", `${core}/v2/businesses/${businessId}/jobs`, {
  customerId,
  title: "עבודת אינטגרציה",
  startsAt: startsAt.toISOString(),
  endsAt: endsAt.toISOString(),
  serviceAddressId: addressResult.body.address.id
}, authHeaders(`job-${suffix}`));
expectStatus(jobResult, 201, "create job");
const jobId = jobResult.body.job.id;

expectStatus(request("PUT", `${core}/v2/businesses/${businessId}/jobs/${jobId}/amount`, {
  totalAmount: 500,
  currency: "ILS"
}, authHeaders(`amount-${suffix}`)), 200, "set job amount");
expectStatus(request("POST", `${core}/v2/businesses/${businessId}/jobs/${jobId}/amount/payments`, {
  mode: "ADD",
  amount: 200
}, authHeaders(`payment-${suffix}`)), 201, "record payment");

expectStatus(request("GET", `${core}/v2/businesses/${businessId}/schedule?from=${encodeURIComponent(startsAt.toISOString())}&to=${encodeURIComponent(endsAt.toISOString())}`, undefined, authHeaders()), 200, "list schedule");
expectStatus(request("POST", `${core}/internal/tasks/due`, { limit: 100 }, { "x-internal-secret": "dev-internal-secret" }), 201, "process due tasks");

console.log(JSON.stringify({ ok: true, businessId, customerId, taskId, jobId }, null, 2));
