import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppointmentsRepository, AuditRepository, CustomersRepository, HomeVisitsRepository, NotesRepository, QuotesRepository, RemindersRepository } from "./core.repositories.js";

function parseRequiredDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date: ${value}`);
  }
  return parsed;
}

@Injectable()
export class CoreActionExecutionService {
  constructor(
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(NotesRepository) private readonly notes: NotesRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(HomeVisitsRepository) private readonly homeVisits: HomeVisitsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository
  ) {}

  async execute(input: {
    businessId: string;
    userId: string;
    actionType: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    resolveDueAt: (businessId: string, payload: Record<string, unknown>) => Promise<Date>;
  }) {
    if (input.actionType === "CREATE_REMINDER") {
      const existing = await this.reminders.findByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) {
        return { type: input.actionType, duplicate: true, reminder: existing };
      }
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!title) {
        throw new BadRequestException("AI pending action payload is missing reminder title");
      }
      const reminder = await this.reminders.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : "NORMAL",
        dueAt: await input.resolveDueAt(input.businessId, input.payload),
        source: "ai_pending_action",
        sourceRef: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "reminder",
        entityId: reminder.id,
        action: "CREATE_REMINDER_FROM_PENDING_ACTION",
        after: reminder as Prisma.InputJsonValue
      });
      return { type: input.actionType, duplicate: false, reminder };
    }

    if (input.actionType === "COMPLETE_REMINDER") {
      const reminderId = typeof input.payload.reminderId === "string" ? input.payload.reminderId : undefined;
      if (!reminderId) {
        throw new BadRequestException("Action payload is missing reminderId");
      }
      const reminder = await this.reminders.complete(input.businessId, reminderId);
      if (!reminder) {
        throw new NotFoundException("Reminder not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "structured_action",
        entityType: "reminder",
        entityId: reminder.id,
        action: "COMPLETE_REMINDER_FROM_ACTION",
        after: reminder as Prisma.InputJsonValue
      });
      return { type: input.actionType, reminder };
    }

    if (input.actionType === "UPDATE_REMINDER") {
      const reminderId = typeof input.payload.reminderId === "string" ? input.payload.reminderId : undefined;
      if (!reminderId) {
        throw new BadRequestException("Action payload is missing reminderId");
      }
      const reminder = await this.reminders.update({
        businessId: input.businessId,
        reminderId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        priority: input.payload.priority === "URGENT" ? "URGENT" : input.payload.priority === "NORMAL" ? "NORMAL" : undefined,
        dueAt: typeof input.payload.dueAt === "string" ? await input.resolveDueAt(input.businessId, input.payload) : undefined,
        status: input.payload.status === "DONE" || input.payload.status === "OPEN" || input.payload.status === "CANCELLED"
          ? input.payload.status
          : undefined
      });
      if (!reminder) {
        throw new NotFoundException("Reminder not found");
      }
      return { type: input.actionType, reminder };
    }

    if (input.actionType === "CREATE_CUSTOMER") {
      const name = typeof input.payload.name === "string" ? input.payload.name : undefined;
      if (!name) {
        throw new BadRequestException("AI pending action payload is missing customer name");
      }
      const customer = await this.customers.create({
        businessId: input.businessId,
        name,
        phone: typeof input.payload.phone === "string" ? input.payload.phone : undefined,
        email: typeof input.payload.email === "string" ? input.payload.email : undefined,
        address: typeof input.payload.address === "string" ? input.payload.address : undefined
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "customer",
        entityId: customer.id,
        action: "CREATE_CUSTOMER_FROM_PENDING_ACTION",
        after: customer as Prisma.InputJsonValue
      });
      return { type: input.actionType, customer };
    }

    if (input.actionType === "UPDATE_CUSTOMER") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      if (!customerId) {
        throw new BadRequestException("Action payload is missing customerId");
      }
      const customer = await this.customers.update({
        businessId: input.businessId,
        customerId,
        name: typeof input.payload.name === "string" ? input.payload.name : undefined,
        phone: typeof input.payload.phone === "string" ? input.payload.phone : undefined,
        email: typeof input.payload.email === "string" ? input.payload.email : undefined,
        address: typeof input.payload.address === "string" ? input.payload.address : undefined
      });
      if (!customer) {
        throw new NotFoundException("Customer not found");
      }
      return { type: input.actionType, customer };
    }

    if (input.actionType === "CREATE_APPOINTMENT" || input.actionType === "CREATE_HOME_VISIT") {
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      const startsAt = typeof input.payload.startsAt === "string" ? input.payload.startsAt : undefined;
      if (!title || !startsAt) {
        throw new BadRequestException("AI pending action payload is missing title or startsAt");
      }
      const repository = input.actionType === "CREATE_HOME_VISIT" ? this.homeVisits : this.appointments;
      const result = await repository.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
        startsAt: parseRequiredDate(startsAt),
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined
      });
      const entityType = input.actionType === "CREATE_HOME_VISIT" ? "home_visit" : "appointment";
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType,
        entityId: result.id,
        action: `${input.actionType}_FROM_PENDING_ACTION`,
        after: result as Prisma.InputJsonValue
      });
      return input.actionType === "CREATE_HOME_VISIT"
        ? { type: input.actionType, homeVisit: result }
        : { type: input.actionType, appointment: result };
    }

    if (input.actionType === "COMPLETE_APPOINTMENT" || input.actionType === "CANCEL_APPOINTMENT") {
      const appointmentId = typeof input.payload.appointmentId === "string" ? input.payload.appointmentId : undefined;
      if (!appointmentId) {
        throw new BadRequestException("Action payload is missing appointmentId");
      }
      const appointment = await this.appointments.update({
        businessId: input.businessId,
        appointmentId,
        status: input.actionType === "COMPLETE_APPOINTMENT" ? "DONE" : "CANCELLED"
      });
      if (!appointment) {
        throw new NotFoundException("Appointment not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "appointment",
        entityId: appointment.id,
        action: `${input.actionType}_FROM_PENDING_ACTION`,
        after: appointment as Prisma.InputJsonValue
      });
      return { type: input.actionType, appointment };
    }

    if (input.actionType === "COMPLETE_HOME_VISIT") {
      const homeVisitId = typeof input.payload.homeVisitId === "string" ? input.payload.homeVisitId : undefined;
      if (!homeVisitId) {
        throw new BadRequestException("Action payload is missing homeVisitId");
      }
      const homeVisit = await this.homeVisits.complete(input.businessId, homeVisitId);
      if (!homeVisit) {
        throw new NotFoundException("Home visit not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "home_visit",
        entityId: homeVisit.id,
        action: "COMPLETE_HOME_VISIT_FROM_PENDING_ACTION",
        after: homeVisit as Prisma.InputJsonValue
      });
      return { type: input.actionType, homeVisit };
    }

    if (input.actionType === "UPDATE_APPOINTMENT" || input.actionType === "UPDATE_HOME_VISIT") {
      const entityId = input.actionType === "UPDATE_HOME_VISIT"
        ? typeof input.payload.homeVisitId === "string" ? input.payload.homeVisitId : undefined
        : typeof input.payload.appointmentId === "string" ? input.payload.appointmentId : undefined;
      if (!entityId) {
        throw new BadRequestException(input.actionType === "UPDATE_HOME_VISIT"
          ? "Action payload is missing homeVisitId"
          : "Action payload is missing appointmentId");
      }
      const status = input.payload.status === "DONE" || input.payload.status === "OPEN" || input.payload.status === "CANCELLED"
        ? input.payload.status
        : undefined;
      const commonUpdate: {
        businessId: string;
        customerId?: string;
        title?: string;
        location?: string;
        notes?: string;
        startsAt?: Date;
        endsAt?: Date;
        status?: "OPEN" | "DONE" | "CANCELLED";
      } = {
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        location: typeof input.payload.location === "string" ? input.payload.location : undefined,
        notes: typeof input.payload.notes === "string" ? input.payload.notes : undefined,
        startsAt: typeof input.payload.startsAt === "string" ? parseRequiredDate(input.payload.startsAt) : undefined,
        endsAt: typeof input.payload.endsAt === "string" ? parseRequiredDate(input.payload.endsAt) : undefined,
        status
      };
      const result = input.actionType === "UPDATE_HOME_VISIT"
        ? await this.homeVisits.update({ ...commonUpdate, homeVisitId: entityId })
        : await this.appointments.update({ ...commonUpdate, appointmentId: entityId });
      if (!result) {
        throw new NotFoundException(input.actionType === "UPDATE_HOME_VISIT" ? "Home visit not found" : "Appointment not found");
      }
      return input.actionType === "UPDATE_HOME_VISIT"
        ? { type: input.actionType, homeVisit: result }
        : { type: input.actionType, appointment: result };
    }

    if (input.actionType === "CREATE_QUOTE") {
      const existing = await this.quotes.findByIdempotencyKey(input.businessId, input.idempotencyKey);
      if (existing) {
        return { type: input.actionType, duplicate: true, quote: existing };
      }
      const title = typeof input.payload.title === "string" ? input.payload.title : undefined;
      if (!title) {
        throw new BadRequestException("Action payload is missing quote title");
      }
      const quote = await this.quotes.create({
        businessId: input.businessId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        estimatedAmount: typeof input.payload.estimatedAmount === "string" || typeof input.payload.estimatedAmount === "number"
          ? new Prisma.Decimal(input.payload.estimatedAmount)
          : undefined,
        dueAt: await input.resolveDueAt(input.businessId, input.payload),
        source: "structured_action",
        sourceRef: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "structured_action",
        entityType: "quote",
        entityId: quote.id,
        action: "CREATE_QUOTE_FROM_ACTION",
        after: quote as Prisma.InputJsonValue
      });
      return { type: input.actionType, duplicate: false, quote };
    }

    if (input.actionType === "MARK_QUOTE_PAID") {
      const quoteId = typeof input.payload.quoteId === "string" ? input.payload.quoteId : undefined;
      if (!quoteId) {
        throw new BadRequestException("Action payload is missing quoteId");
      }
      const quote = await this.quotes.markPaid(input.businessId, quoteId);
      if (!quote) {
        throw new NotFoundException("Quote not found");
      }
      return { type: input.actionType, quote };
    }

    if (input.actionType === "CANCEL_QUOTE") {
      const quoteId = typeof input.payload.quoteId === "string" ? input.payload.quoteId : undefined;
      if (!quoteId) {
        throw new BadRequestException("Action payload is missing quoteId");
      }
      const quote = await this.quotes.update({
        businessId: input.businessId,
        quoteId,
        status: "CANCELLED"
      });
      if (!quote) {
        throw new NotFoundException("Quote not found");
      }
      return { type: input.actionType, quote };
    }

    if (input.actionType === "UPDATE_QUOTE") {
      const quoteId = typeof input.payload.quoteId === "string" ? input.payload.quoteId : undefined;
      if (!quoteId) {
        throw new BadRequestException("Action payload is missing quoteId");
      }
      const quote = await this.quotes.update({
        businessId: input.businessId,
        quoteId,
        customerId: typeof input.payload.customerId === "string" ? input.payload.customerId : undefined,
        title: typeof input.payload.title === "string" ? input.payload.title : undefined,
        description: typeof input.payload.description === "string" ? input.payload.description : undefined,
        estimatedAmount: typeof input.payload.estimatedAmount === "string" || typeof input.payload.estimatedAmount === "number"
          ? new Prisma.Decimal(input.payload.estimatedAmount)
          : undefined,
        dueAt: typeof input.payload.dueAt === "string" ? await input.resolveDueAt(input.businessId, input.payload) : undefined,
        status: input.payload.status === "PAID"
          ? "PAID"
          : input.payload.status === "CANCELLED"
            ? "CANCELLED"
            : input.payload.status === "OPEN"
              ? "OPEN"
              : undefined
      });
      if (!quote) {
        throw new NotFoundException("Quote not found");
      }
      return { type: input.actionType, quote };
    }

    if (input.actionType === "MERGE_CUSTOMERS") {
      const sourceCustomerId = typeof input.payload.sourceCustomerId === "string" ? input.payload.sourceCustomerId : undefined;
      const targetCustomerId = typeof input.payload.targetCustomerId === "string" ? input.payload.targetCustomerId : undefined;
      if (!sourceCustomerId || !targetCustomerId) {
        throw new BadRequestException("Action payload is missing sourceCustomerId or targetCustomerId");
      }
      const merge = await this.customers.merge({
        businessId: input.businessId,
        sourceCustomerId,
        targetCustomerId,
        mergedByUserId: input.userId
      });
      if (!merge) {
        throw new NotFoundException("Customer not found");
      }
      return { type: input.actionType, merge };
    }

    if (input.actionType === "DELETE_WORK_ITEM") {
      const itemType = typeof input.payload.itemType === "string" ? input.payload.itemType : undefined;
      const itemId = typeof input.payload.itemId === "string" ? input.payload.itemId : undefined;
      if (!itemType || !itemId) {
        throw new BadRequestException("Action payload is missing itemType or itemId");
      }
      if (itemType === "reminder") {
        const item = await this.reminders.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Reminder not found");
        return { type: input.actionType, item };
      }
      if (itemType === "home_visit") {
        const item = await this.homeVisits.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Home visit not found");
        return { type: input.actionType, item };
      }
      if (itemType === "appointment") {
        const item = await this.appointments.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Appointment not found");
        return { type: input.actionType, item };
      }
      if (itemType === "quote") {
        const item = await this.quotes.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Quote not found");
        return { type: input.actionType, item };
      }
      if (itemType === "note") {
        const item = await this.notes.softDelete(input.businessId, itemId);
        if (!item) throw new NotFoundException("Customer note not found");
        return { type: input.actionType, item };
      }
      throw new BadRequestException("Unsupported work item type");
    }

    if (input.actionType === "CREATE_NOTE") {
      const customerId = typeof input.payload.customerId === "string" ? input.payload.customerId : undefined;
      const text = typeof input.payload.text === "string" ? input.payload.text : undefined;
      if (!customerId || !text) {
        throw new BadRequestException("AI pending action payload is missing note customerId or text");
      }
      const note = await this.notes.create({
        businessId: input.businessId,
        customerId,
        text
      });
      if (!note) {
        throw new NotFoundException("Customer not found");
      }
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "ai_pending_action",
        entityType: "customer_note",
        entityId: note.id,
        action: "CREATE_CUSTOMER_NOTE_FROM_PENDING_ACTION",
        after: note as Prisma.InputJsonValue
      });
      return { type: input.actionType, note };
    }

    return {
      type: input.actionType,
      status: "MOCK_ACCEPTED",
      payload: input.payload
    };
  }

}
