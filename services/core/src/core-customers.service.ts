import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CreateCustomerSchema, CreateNoteSchema, MergeCustomerSchema, UpdateCustomerSchema, UpdateNoteSchema } from "@myclient/contracts";
import { AuditRepository, CustomersRepository, HomeVisitsRepository, IncomingCallsRepository, NotesRepository, QuotesRepository, RemindersRepository } from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreWorkItemPresenter } from "./core-work-item.presenter.js";
import { callDisplayStatus, callIvrSelection, paginatedResponse, paginationFromQuery, publicCustomer, reminderStatus, scheduledTimeOrZero, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreCustomersService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(NotesRepository) private readonly notes: NotesRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(HomeVisitsRepository) private readonly homeVisits: HomeVisitsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository,
    @Inject(IncomingCallsRepository) private readonly incomingCalls: IncomingCallsRepository,
    @Inject(CoreWorkItemPresenter) private readonly workItemPresenter: CoreWorkItemPresenter
  ) {}
  async createCustomer(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateCustomerSchema.parse(body);
    const duplicate = await this.customers.findDuplicateByPhone(businessId, command.phone);
    const { customer, initialNote } = await this.customers.createWithInitialNoteAndAudit({
      businessId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address,
      initialNote: command.initialNote,
      actorUserId: user.id
    });
    return { customer, duplicateCustomer: duplicate, initialNote };
  }
  async listCustomers(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.customers.listByBusiness(businessId, pagination), pagination.limit);
    return { customers: page.items, pageInfo: page.pageInfo };
  }
  async getCustomer(headers: RequestHeaders, businessId: string, customerId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const customer = await this.customers.findByBusinessAndId(businessId, customerId);
    if (!customer) {
      throw new NotFoundException("Customer not found");
    }

    const [reminders, homeVisits, quotes, notes] = await Promise.all([
      this.reminders.listByCustomer(businessId, customerId),
      this.homeVisits.listByCustomer(businessId, customerId),
      this.quotes.listByCustomer(businessId, customerId),
      this.notes.listByCustomer(businessId, customerId)
    ]);
    const activity = [
      ...reminders.map((reminder) => this.workItemPresenter.reminderWorkItem(reminder)),
      ...homeVisits.map((homeVisit) => this.workItemPresenter.homeVisitWorkItem(homeVisit)),
      ...quotes.map((quote) => this.workItemPresenter.quoteWorkItem(quote)),
      ...(notes ?? []).map((note) => ({
        id: note.id,
        type: "note",
        title: "הערה",
        description: note.text,
        dueAt: null,
        priority: "NORMAL",
        status: note.status,
        source: "note",
        customer: publicCustomer(customer),
        linkedEntity: { type: "note", id: note.id },
        actions: note.status === "DONE" ? ["open", "reopen"] : ["open", "complete"]
      }))
    ].sort((a, b) => scheduledTimeOrZero(b) - scheduledTimeOrZero(a));

    return { customer, activity };
  }
  async updateCustomer(
    headers: RequestHeaders,
    businessId: string,
    customerId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateCustomerSchema.parse(body);
    const customer = await this.customers.update({
      businessId,
      customerId,
      name: command.name,
      phone: command.phone,
      email: command.email,
      address: command.address
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: customer.id,
      action: "UPDATE_CUSTOMER",
      after: customer as Prisma.InputJsonValue
    });
    return { customer };
  }
  async deleteCustomer(
    headers: RequestHeaders,
    businessId: string,
    customerId: string
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const deletion = await this.customers.softDelete({ businessId, customerId });
    if (!deletion) {
      throw new NotFoundException("Customer not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: deletion.customer.id,
      action: "DELETE_CUSTOMER",
      after: deletion as Prisma.InputJsonValue
    });
    return { customer: deletion.customer, deleted: deletion.deleted };
  }
  async mergeCustomer(
    headers: RequestHeaders,
    businessId: string,
    customerId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = MergeCustomerSchema.parse(body);
    const merge = await this.customers.merge({
      businessId,
      sourceCustomerId: customerId,
      targetCustomerId: command.targetCustomerId,
      mergedByUserId: user.id,
      fieldChoices: command.fieldChoices
    });
    if (!merge) {
      throw new NotFoundException("Customer not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer",
      entityId: customerId,
      action: "MERGE_CUSTOMER",
      after: merge as Prisma.InputJsonValue
    });
    return { merge };
  }
  async createNote(
    headers: RequestHeaders,
    businessId: string,
    customerId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateNoteSchema.parse(body);
    const note = await this.notes.create({
      businessId,
      customerId,
      text: command.text
    });

    if (!note) {
      throw new NotFoundException("Customer not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer_note",
      entityId: note.id,
      action: "CREATE_CUSTOMER_NOTE",
      after: note as Prisma.InputJsonValue
    });
    return { note };
  }
  async updateNote(
    headers: RequestHeaders,
    businessId: string,
    customerId: string,
    noteId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateNoteSchema.parse(body);
    const note = await this.notes.update({
      businessId,
      customerId,
      noteId,
      text: command.text,
      status: command.status
    });

    if (!note) {
      throw new NotFoundException("Customer note not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer_note",
      entityId: note.id,
      action: "UPDATE_CUSTOMER_NOTE",
      after: note as Prisma.InputJsonValue
    });
    return { note };
  }
  async deleteNote(
    headers: RequestHeaders,
    businessId: string,
    customerId: string,
    noteId: string
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const note = await this.notes.softDelete(businessId, noteId, customerId);
    if (!note) {
      throw new NotFoundException("Customer note not found");
    }

    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "customer_note",
      entityId: note.id,
      action: "DELETE_CUSTOMER_NOTE",
      after: note as Prisma.InputJsonValue
    });
    return { note };
  }
  async listNotes(headers: RequestHeaders, businessId: string, customerId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const notes = await this.notes.listByCustomer(businessId, customerId);
    if (!notes) {
      throw new NotFoundException("Customer not found");
    }

    return { notes };
  }
  async listIncomingCalls(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const callsPage = paginatedResponse(await this.incomingCalls.listByBusiness(businessId, pagination), pagination.limit);
    return {
      calls: await Promise.all(callsPage.items.map(async (call) => {
        const transcript = call.transcripts.at(-1) ?? null;
        const relatedReminder = transcript?.reminderId ? await this.reminders.findByBusinessAndId(businessId, transcript.reminderId) : null;
        const customer = call.fromNumber ? await this.customers.findDuplicateByPhone(businessId, call.fromNumber) : null;
        return {
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          calledAt: call.createdAt,
          durationSeconds: null,
          ivrSelection: callIvrSelection(call),
          displayStatus: relatedReminder?.status === "DONE" ? "REMINDER_DONE" : callDisplayStatus(call),
          urgent: call.urgent,
          transcriptPreview: transcript?.transcript ?? null,
          relatedReminder: relatedReminder ? {
            id: relatedReminder.id,
            status: reminderStatus(relatedReminder.status),
            dueAt: relatedReminder.dueAt,
            priority: relatedReminder.priority
          } : null,
          customer: publicCustomer(customer)
        };
      })),
      pageInfo: callsPage.pageInfo
    };
  }
}
