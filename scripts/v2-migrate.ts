import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import { normalizeIsraeliPhone, normalizeServiceAddress } from "../services/core/src/v2-normalization.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Manifest = { approvedAppointmentIds?: string[] };
type MigrationIssue = { code: string; entityType: string; entityId?: string; detail: string; blocking: boolean };
type IdMap = { sourceType: string; sourceId: string; targetType: string; targetId: string };

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string) {
  return process.argv.includes(name);
}

function deterministicId(scope: string, sourceId: string) {
  const hex = createHash("sha256").update(`myclient-v2:${scope}:${sourceId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadManifest(path?: string): Promise<Manifest> {
  if (!path) return {};
  const value = JSON.parse(await readFile(path, "utf8")) as Manifest;
  if (value.approvedAppointmentIds && !Array.isArray(value.approvedAppointmentIds)) throw new Error("approvedAppointmentIds must be an array");
  return value;
}

async function collectReport(db: Db, businessId: string, manifest: Manifest) {
  const business = await db.business.findUnique({ where: { id: businessId } });
  if (!business) throw new Error(`Business not found: ${businessId}`);
  const [customers, reminders, appointments, homeVisits, quotes, pendingActions, targetPhones, targetAddresses, targetTasks, targetJobs, targetVisits] = await Promise.all([
    db.customer.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    db.reminder.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    db.appointment.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    db.homeVisit.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    db.quote.findMany({ where: { businessId }, orderBy: { id: "asc" } }),
    db.aiPendingAction.findMany({ where: { businessId, status: "PENDING" }, select: { id: true, actionType: true } }),
    db.customerPhone.findMany({ where: { businessId }, select: { id: true, customerId: true, normalizedPhone: true } }),
    db.serviceAddress.findMany({ where: { businessId }, select: { id: true, customerId: true, normalizedAddress: true } }),
    db.task.findMany({ where: { businessId }, select: { id: true, sourceRef: true } }),
    db.job.findMany({ where: { businessId }, select: { id: true, idempotencyKey: true } }),
    db.visit.findMany({ where: { businessId }, select: { id: true, idempotencyKey: true } })
  ]);
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const approvedAppointments = new Set(manifest.approvedAppointmentIds ?? []);
  const issues: MigrationIssue[] = [];
  const idMap: IdMap[] = [];
  const normalizedPhoneOwners = new Map<string, string>();

  for (const customer of customers) {
    idMap.push({ sourceType: "Customer", sourceId: customer.id, targetType: "Customer", targetId: customer.id });
    if (customer.phone?.trim()) {
      try {
        const normalized = normalizeIsraeliPhone(customer.phone);
        if (!normalized) throw new Error("invalid phone");
        const owner = normalizedPhoneOwners.get(normalized);
        if (owner && owner !== customer.id) issues.push({ code: "DUPLICATE_NORMALIZED_PHONE", entityType: "Customer", entityId: customer.id, detail: `${normalized} משויך גם ל-${owner}`, blocking: true });
        normalizedPhoneOwners.set(normalized, owner ?? customer.id);
        const existing = targetPhones.find((phone) => phone.normalizedPhone === normalized && phone.customerId === customer.id);
        const conflicting = targetPhones.find((phone) => phone.normalizedPhone === normalized && phone.customerId !== customer.id);
        if (conflicting) issues.push({ code: "DUPLICATE_NORMALIZED_PHONE", entityType: "Customer", entityId: customer.id, detail: `${normalized} כבר משויך ל-${conflicting.customerId}`, blocking: true });
        idMap.push({ sourceType: "Customer.phone", sourceId: customer.id, targetType: "CustomerPhone", targetId: existing?.id ?? deterministicId("customer-phone", customer.id) });
      } catch {
        issues.push({ code: "INVALID_PHONE", entityType: "Customer", entityId: customer.id, detail: "מספר הטלפון אינו ניתן לנרמול בטוח", blocking: true });
      }
    }
    if (customer.address?.trim()) {
      const normalized = normalizeServiceAddress(customer.address);
      const existing = targetAddresses.find((address) => address.customerId === customer.id && address.normalizedAddress === normalized);
      idMap.push({ sourceType: "Customer.address", sourceId: customer.id, targetType: "ServiceAddress", targetId: existing?.id ?? deterministicId("service-address", customer.id) });
    }
  }

  for (const reminder of reminders) {
    idMap.push({ sourceType: "Reminder", sourceId: reminder.id, targetType: "Task", targetId: reminder.id });
    if (reminder.customerId && !customerById.has(reminder.customerId)) issues.push({ code: "BROKEN_CUSTOMER_REFERENCE", entityType: "Reminder", entityId: reminder.id, detail: reminder.customerId, blocking: true });
    if (reminder.customerId && customerById.get(reminder.customerId)?.mergedIntoCustomerId) issues.push({ code: "MERGED_CUSTOMER_REFERENCE", entityType: "Reminder", entityId: reminder.id, detail: reminder.customerId, blocking: true });
    const collision = targetTasks.find((item) => item.id === reminder.id && item.sourceRef !== `Reminder:${reminder.id}`);
    if (collision) issues.push({ code: "TARGET_ID_COLLISION", entityType: "Reminder", entityId: reminder.id, detail: "Task קיים עם אותו מזהה ומקור אחר", blocking: true });
  }
  for (const visit of homeVisits) {
    idMap.push({ sourceType: "HomeVisit", sourceId: visit.id, targetType: "Visit", targetId: visit.id });
    if (!visit.customerId || !customerById.has(visit.customerId)) issues.push({ code: "MISSING_CUSTOMER", entityType: "HomeVisit", entityId: visit.id, detail: "ביקור בית ללא לקוח תקף", blocking: true });
    else if (customerById.get(visit.customerId)?.mergedIntoCustomerId) issues.push({ code: "MERGED_CUSTOMER_REFERENCE", entityType: "HomeVisit", entityId: visit.id, detail: visit.customerId, blocking: true });
    const collision = targetVisits.find((item) => item.id === visit.id && item.idempotencyKey !== `migration:v1:home-visit:${visit.id}`);
    if (collision) issues.push({ code: "TARGET_ID_COLLISION", entityType: "HomeVisit", entityId: visit.id, detail: "Visit קיים עם אותו מזהה ומקור אחר", blocking: true });
  }
  for (const appointment of appointments) {
    idMap.push({ sourceType: "Appointment", sourceId: appointment.id, targetType: "Job", targetId: appointment.id });
    if (!appointment.customerId || !customerById.has(appointment.customerId)) issues.push({ code: "MISSING_CUSTOMER", entityType: "Appointment", entityId: appointment.id, detail: "פגישה ללא לקוח תקף", blocking: true });
    else if (customerById.get(appointment.customerId)?.mergedIntoCustomerId) issues.push({ code: "MERGED_CUSTOMER_REFERENCE", entityType: "Appointment", entityId: appointment.id, detail: appointment.customerId, blocking: true });
    if (!approvedAppointments.has(appointment.id)) issues.push({ code: "APPOINTMENT_REVIEW_REQUIRED", entityType: "Appointment", entityId: appointment.id, detail: "יש לאשר במפורש שהרשומה היא Job", blocking: true });
    const collision = targetJobs.find((item) => item.id === appointment.id && item.idempotencyKey !== `migration:v1:appointment:${appointment.id}`);
    if (collision) issues.push({ code: "TARGET_ID_COLLISION", entityType: "Appointment", entityId: appointment.id, detail: "Job קיים עם אותו מזהה ומקור אחר", blocking: true });
  }
  for (const approvedId of approvedAppointments) if (!appointments.some((appointment) => appointment.id === approvedId)) issues.push({ code: "UNKNOWN_APPROVED_APPOINTMENT", entityType: "Appointment", entityId: approvedId, detail: "המזהה אושר במניפסט אך אינו קיים בעסק", blocking: true });
  for (const quote of quotes) issues.push({ code: "LEGACY_QUOTE", entityType: "Quote", entityId: quote.id, detail: "הצעת המחיר נשארת ב-V1 לקריאה בלבד ואינה מומרת ל-Amount", blocking: false });
  for (const pending of pendingActions) issues.push({ code: "PENDING_V1_AI_ACTION", entityType: "AiPendingAction", entityId: pending.id, detail: pending.actionType, blocking: true });

  const counts = {
    source: { customers: customers.length, customerPhones: customers.filter((item) => item.phone?.trim()).length, serviceAddresses: customers.filter((item) => item.address?.trim()).length, reminders: reminders.length, appointments: appointments.length, homeVisits: homeVisits.length, quotes: quotes.length },
    target: { customerPhones: targetPhones.length, serviceAddresses: targetAddresses.length, tasks: targetTasks.length, jobs: targetJobs.length, visits: targetVisits.length }
  };
  const orderedMap = idMap.sort((left, right) => `${left.sourceType}:${left.sourceId}`.localeCompare(`${right.sourceType}:${right.sourceId}`));
  return {
    generatedAt: new Date().toISOString(),
    business: { id: business.id, name: business.name, productModelVersion: business.productModelVersion, v1WriteBlockedAt: business.v1WriteBlockedAt },
    counts,
    issues,
    blockingIssueCount: issues.filter((issue) => issue.blocking).length,
    idMap: orderedMap,
    checksum: checksum({ businessId, counts, issues: issues.map(({ code, entityType, entityId, blocking }) => ({ code, entityType, entityId, blocking })), idMap: orderedMap })
  };
}

function activityStatus(status: "OPEN" | "DONE" | "CANCELLED") {
  return status === "DONE" ? "CLOSED" as const : status;
}

async function backfill(tx: Prisma.TransactionClient, businessId: string, manifest: Manifest) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`v2_cutover:${businessId}`}))`;
  const customers = await tx.customer.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
  for (const customer of customers) {
    if (customer.phone?.trim()) {
      const normalizedPhone = normalizeIsraeliPhone(customer.phone);
      if (!normalizedPhone) throw new Error(`Customer ${customer.id} has an invalid phone`);
      const existing = await tx.customerPhone.findFirst({ where: { businessId, normalizedPhone } });
      if (!existing) {
        const activeCount = await tx.customerPhone.count({ where: { businessId, customerId: customer.id, deletedAt: null } });
        await tx.customerPhone.create({ data: { id: deterministicId("customer-phone", customer.id), businessId, customerId: customer.id, rawPhone: customer.phone, normalizedPhone, label: "טלפון V1", isPrimary: activeCount === 0, deletedAt: customer.deletedAt } });
      }
    }
    if (customer.address?.trim()) {
      const normalizedAddress = normalizeServiceAddress(customer.address);
      const existing = await tx.serviceAddress.findFirst({ where: { businessId, customerId: customer.id, normalizedAddress } });
      if (!existing) await tx.serviceAddress.create({ data: { id: deterministicId("service-address", customer.id), businessId, customerId: customer.id, addressText: customer.address, normalizedAddress, deletedAt: customer.deletedAt } });
    }
  }

  const reminders = await tx.reminder.findMany({ where: { businessId } });
  for (const reminder of reminders) {
    await tx.task.upsert({
      where: { id: reminder.id },
      create: { id: reminder.id, businessId, customerId: reminder.customerId, title: reminder.title, description: reminder.description, status: reminder.status, dueAt: reminder.dueAt, reminderSentAt: reminder.reminderSentAt, source: "migration_v1", sourceRef: `Reminder:${reminder.id}`, idempotencyKey: `migration:v1:reminder:${reminder.id}`, deletedAt: reminder.deletedAt, createdAt: reminder.createdAt },
      update: {}
    });
  }
  const homeVisits = await tx.homeVisit.findMany({ where: { businessId } });
  for (const visit of homeVisits) {
    if (!visit.customerId) throw new Error(`HomeVisit ${visit.id} is missing customer`);
    await tx.visit.upsert({
      where: { id: visit.id },
      create: { id: visit.id, businessId, customerId: visit.customerId, title: visit.title, description: visit.notes, startsAt: visit.startsAt, endsAt: visit.endsAt, locationSnapshot: visit.location, status: activityStatus(visit.status), idempotencyKey: `migration:v1:home-visit:${visit.id}`, deletedAt: visit.deletedAt, createdAt: visit.createdAt },
      update: {}
    });
  }
  const approved = new Set(manifest.approvedAppointmentIds ?? []);
  const appointments = await tx.appointment.findMany({ where: { businessId } });
  for (const appointment of appointments) {
    if (!appointment.customerId || !approved.has(appointment.id)) throw new Error(`Appointment ${appointment.id} was not approved for Job migration`);
    await tx.job.upsert({
      where: { id: appointment.id },
      create: { id: appointment.id, businessId, customerId: appointment.customerId, title: appointment.title, description: appointment.notes, startsAt: appointment.startsAt, endsAt: appointment.endsAt, locationSnapshot: appointment.location, status: activityStatus(appointment.status), idempotencyKey: `migration:v1:appointment:${appointment.id}`, deletedAt: appointment.deletedAt, createdAt: appointment.createdAt },
      update: {}
    });
  }
}

async function validateMappings(tx: Prisma.TransactionClient, businessId: string, idMap: IdMap[]) {
  const grouped = new Map<string, string[]>();
  for (const mapping of idMap) grouped.set(mapping.targetType, [...(grouped.get(mapping.targetType) ?? []), mapping.targetId]);
  const counts = new Map<string, number>();
  counts.set("Customer", await tx.customer.count({ where: { businessId, id: { in: grouped.get("Customer") ?? [] } } }));
  counts.set("CustomerPhone", await tx.customerPhone.count({ where: { businessId, id: { in: grouped.get("CustomerPhone") ?? [] } } }));
  counts.set("ServiceAddress", await tx.serviceAddress.count({ where: { businessId, id: { in: grouped.get("ServiceAddress") ?? [] } } }));
  counts.set("Task", await tx.task.count({ where: { businessId, id: { in: grouped.get("Task") ?? [] } } }));
  counts.set("Job", await tx.job.count({ where: { businessId, id: { in: grouped.get("Job") ?? [] } } }));
  counts.set("Visit", await tx.visit.count({ where: { businessId, id: { in: grouped.get("Visit") ?? [] } } }));
  return [...grouped].flatMap(([targetType, ids]) => counts.get(targetType) === new Set(ids).size ? [] : [{ targetType, expected: new Set(ids).size, actual: counts.get(targetType) ?? 0 }]);
}

async function main() {
  const businessId = option("--business-id");
  const dryRun = has("--dry-run");
  const apply = has("--apply");
  if (!businessId || Number(dryRun) + Number(apply) !== 1) throw new Error("Usage: npm run v2:migrate -- --business-id <id> (--dry-run | --apply --confirm-cutover) [--manifest file.json] [--output report.json]");
  const manifest = await loadManifest(option("--manifest"));
  const prisma = new PrismaClient();
  try {
    const initial = await collectReport(prisma, businessId, manifest);
    if (dryRun) return await emit(initial, option("--output"));
    if (!has("--confirm-cutover")) throw new Error("--apply requires --confirm-cutover");
    if (initial.blockingIssueCount > 0) throw new Error(`Cutover blocked by ${initial.blockingIssueCount} migration issues. Run --dry-run and resolve them first.`);

    await prisma.business.updateMany({ where: { id: businessId, v1WriteBlockedAt: null }, data: { v1WriteBlockedAt: new Date() } });
    const result = await prisma.$transaction(async (tx) => {
      const preflight = await collectReport(tx, businessId, manifest);
      if (preflight.blockingIssueCount > 0) throw new Error(`Cutover state changed; ${preflight.blockingIssueCount} blocking issues are now present.`);
      await backfill(tx, businessId, manifest);
      const validation = await collectReport(tx, businessId, manifest);
      const missingMappings = await validateMappings(tx, businessId, validation.idMap);
      if (missingMappings.length > 0) throw new Error(`Backfill validation failed: ${JSON.stringify(missingMappings)}`);
      await tx.business.update({ where: { id: businessId }, data: { productModelVersion: 2 } });
      return { ...validation, cutover: { productModelVersion: 2, v1ReadOnly: true, validated: true, missingMappings } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
    await emit(result, option("--output"));
  } finally {
    await prisma.$disconnect();
  }
}

async function emit(report: unknown, output?: string) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, json, "utf8");
  process.stdout.write(json);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
