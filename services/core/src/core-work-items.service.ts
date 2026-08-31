import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CreateAppointmentSchema, CreateHomeVisitSchema, CreateQuoteSchema, CreateReminderSchema, HomeQuerySchema, UpdateAppointmentSchema, UpdateHomeVisitSchema, UpdateQuoteSchema, UpdateReminderSchema } from "@myclient/contracts";
import { AppointmentsRepository, AuditRepository, BusinessSettingsRepository, HomeVisitsRepository, QuotesRepository, RemindersRepository } from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreWorkItemPresenter } from "./core-work-item.presenter.js";
import { addUtcDays, defaultAiReminderDueAt, homeVisitStatus, isSameUtcInstant, paginatedResponse, paginationFromQuery, parseOptionalAmount, parseOptionalDate, parseRequiredDate, reminderStatus, scheduledTimeOrZero, startOfLocalDate, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreWorkItemsService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(HomeVisitsRepository) private readonly homeVisits: HomeVisitsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository,
    @Inject(CoreWorkItemPresenter) private readonly workItemPresenter: CoreWorkItemPresenter
  ) {}
  async getWorkItem(headers: RequestHeaders, businessId: string, itemType: string, itemId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const item = await (async () => {
      switch (itemType) {
        case "reminder": {
          const reminder = await this.reminders.findByBusinessAndId(businessId, itemId);
          return reminder ? this.workItemPresenter.reminderWorkItem(reminder) : null;
        }
        case "appointment": {
          const appointment = await this.appointments.findByBusinessAndId(businessId, itemId);
          return appointment ? this.workItemPresenter.appointmentWorkItem(appointment) : null;
        }
        case "home_visit": {
          const homeVisit = await this.homeVisits.findByBusinessAndId(businessId, itemId);
          return homeVisit ? this.workItemPresenter.homeVisitWorkItem(homeVisit) : null;
        }
        case "quote": {
          const quote = await this.quotes.findByBusinessAndId(businessId, itemId);
          return quote ? this.workItemPresenter.quoteWorkItem(quote) : null;
        }
        default:
          throw new NotFoundException("Work item not found");
      }
    })();
    if (!item) throw new NotFoundException("Work item not found");
    return { item };
  }
  async getHome(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = HomeQuerySchema.parse(query);
    const settings = await this.settings.getByBusiness(businessId);
    const start = startOfLocalDate(command.date, settings.timezone);
    const end = addUtcDays(start, 1);
    const includeOpenBeforeStart = isSameUtcInstant(start, startOfLocalDate(undefined, settings.timezone));
    const [reminders, homeVisits, appointments, quotes] = await Promise.all([
      command.filter === "home_visits" || command.filter === "appointments" || command.filter === "quotes" || command.filter === "calls"
        ? Promise.resolve([])
        : this.reminders.listRemindersForDate({ businessId, start, end, search: command.search, urgentOnly: command.filter === "urgent", includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "appointments" || command.filter === "quotes" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.homeVisits.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "home_visits" || command.filter === "quotes" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.appointments.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart }),
      command.filter === "reminders" || command.filter === "home_visits" || command.filter === "appointments" || command.filter === "calls" || command.filter === "urgent"
        ? Promise.resolve([])
        : this.quotes.listForDate({ businessId, start, end, search: command.search, includeOpenBeforeStart })
    ]);

    const items = [
      ...reminders.map((reminder) => this.workItemPresenter.reminderWorkItem(reminder)),
      ...homeVisits.map((homeVisit) => this.workItemPresenter.homeVisitWorkItem(homeVisit)),
      ...appointments.map((appointment) => this.workItemPresenter.appointmentWorkItem(appointment)),
      ...quotes.map((quote) => this.workItemPresenter.quoteWorkItem(quote))
    ].sort((a, b) => {
      const priority = Number(b.priority === "URGENT") - Number(a.priority === "URGENT");
      if (priority !== 0) return priority;
      return scheduledTimeOrZero(a) - scheduledTimeOrZero(b);
    });

    return {
      date: command.date ?? start.toISOString().slice(0, 10),
      filter: command.filter,
      items
    };
  }
  async listReminders(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.reminders.listRemindersByBusiness(businessId, pagination), pagination.limit);
    return { reminders: page.items.map((reminder) => this.workItemPresenter.reminder(reminder)), pageInfo: page.pageInfo };
  }
  async createReminder(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateReminderSchema.parse(body);
    const reminder = await this.reminders.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt) ?? await this.resolveAiReminderDueAt(businessId),
      status: command.status,
      source: "app"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "CREATE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.workItemPresenter.reminder(reminder) };
  }
  async updateReminder(
    headers: RequestHeaders,
    businessId: string,
    reminderId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateReminderSchema.parse(body);
    const reminder = await this.reminders.update({
      businessId,
      reminderId: reminderId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      priority: command.priority,
      dueAt: parseOptionalDate(command.dueAt),
      status: command.status
    });
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "UPDATE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.workItemPresenter.reminder(reminder) };
  }
  async completeReminder(headers: RequestHeaders, businessId: string, reminderId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const reminder = await this.reminders.complete(businessId, reminderId);
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "COMPLETE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.workItemPresenter.reminder(reminder) };
  }
  async deleteReminder(headers: RequestHeaders, businessId: string, reminderId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const reminder = await this.reminders.softDelete(businessId, reminderId);
    if (!reminder) {
      throw new NotFoundException("Reminder not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "reminder",
      entityId: reminder.id,
      action: "DELETE_REMINDER",
      after: reminder as Prisma.InputJsonValue
    });
    return { reminder: this.workItemPresenter.reminder(reminder) };
  }
  async listAppointments(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.appointments.listByBusiness(businessId, pagination), pagination.limit);
    return { appointments: page.items, pageInfo: page.pageInfo };
  }
  async createAppointment(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateAppointmentSchema.parse(body);
    const appointment = await this.appointments.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: parseRequiredDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "CREATE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }
  async updateAppointment(
    headers: RequestHeaders,
    businessId: string,
    appointmentId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateAppointmentSchema.parse(body);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: command.startsAt ? parseRequiredDate(command.startsAt) : undefined,
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "UPDATE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }
  async deleteAppointment(headers: RequestHeaders, businessId: string, appointmentId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.softDelete(businessId, appointmentId);
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "DELETE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }
  async listHomeVisits(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.homeVisits.listByBusiness(businessId, pagination), pagination.limit);
    return { homeVisits: page.items.map((homeVisit) => this.workItemPresenter.homeVisit(homeVisit)), pageInfo: page.pageInfo };
  }
  async createHomeVisit(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateHomeVisitSchema.parse(body);
    const homeVisit = await this.homeVisits.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: parseRequiredDate(command.startsAt),
      endsAt: parseOptionalDate(command.endsAt) ?? new Date(parseRequiredDate(command.startsAt).getTime() + 30 * 60 * 1000),
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "CREATE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.workItemPresenter.homeVisit(homeVisit) };
  }
  async updateHomeVisit(
    headers: RequestHeaders,
    businessId: string,
    homeVisitId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateHomeVisitSchema.parse(body);
    const homeVisit = await this.homeVisits.update({
      businessId,
      homeVisitId,
      customerId: command.customerId,
      title: command.title,
      location: command.location,
      notes: command.notes,
      startsAt: command.startsAt ? parseRequiredDate(command.startsAt) : undefined,
      endsAt: parseOptionalDate(command.endsAt),
      status: command.status
    });
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "UPDATE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.workItemPresenter.homeVisit(homeVisit) };
  }
  async completeHomeVisit(headers: RequestHeaders, businessId: string, homeVisitId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const homeVisit = await this.homeVisits.complete(businessId, homeVisitId);
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "COMPLETE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.workItemPresenter.homeVisit(homeVisit) };
  }
  async deleteHomeVisit(headers: RequestHeaders, businessId: string, homeVisitId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const homeVisit = await this.homeVisits.softDelete(businessId, homeVisitId);
    if (!homeVisit) {
      throw new NotFoundException("Home visit not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "home_visit",
      entityId: homeVisit.id,
      action: "DELETE_HOME_VISIT",
      after: homeVisit as Prisma.InputJsonValue
    });
    return { homeVisit: this.workItemPresenter.homeVisit(homeVisit) };
  }
  async listQuotes(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.quotes.listByBusiness(businessId, pagination), pagination.limit);
    return { quotes: page.items.map((quote) => this.workItemPresenter.quote(quote)), pageInfo: page.pageInfo };
  }
  async createQuote(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateQuoteSchema.parse(body);
    const quote = await this.quotes.create({
      businessId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      estimatedAmount: command.estimatedAmount === undefined ? undefined : new Prisma.Decimal(command.estimatedAmount),
      dueAt: parseRequiredDate(command.dueAt),
      status: command.status,
      source: "app"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "CREATE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.workItemPresenter.quote(quote) };
  }
  async updateQuote(
    headers: RequestHeaders,
    businessId: string,
    quoteId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateQuoteSchema.parse(body);
    const quote = await this.quotes.update({
      businessId,
      quoteId,
      customerId: command.customerId,
      title: command.title,
      description: command.description,
      estimatedAmount: parseOptionalAmount(command.estimatedAmount),
      dueAt: command.dueAt ? parseRequiredDate(command.dueAt) : undefined,
      status: command.status
    });
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "UPDATE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.workItemPresenter.quote(quote) };
  }
  async markQuotePaid(headers: RequestHeaders, businessId: string, quoteId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const quote = await this.quotes.markPaid(businessId, quoteId);
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "MARK_QUOTE_PAID",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.workItemPresenter.quote(quote) };
  }
  async deleteQuote(headers: RequestHeaders, businessId: string, quoteId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const quote = await this.quotes.softDelete(businessId, quoteId);
    if (!quote) {
      throw new NotFoundException("Quote not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "quote",
      entityId: quote.id,
      action: "DELETE_QUOTE",
      after: quote as Prisma.InputJsonValue
    });
    return { quote: this.workItemPresenter.quote(quote) };
  }
  async cancelAppointment(headers: RequestHeaders, businessId: string, appointmentId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      status: "CANCELLED"
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "CANCEL_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }
  async completeAppointment(headers: RequestHeaders, businessId: string, appointmentId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const appointment = await this.appointments.update({
      businessId,
      appointmentId,
      status: "DONE"
    });
    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "appointment",
      entityId: appointment.id,
      action: "COMPLETE_APPOINTMENT",
      after: appointment as Prisma.InputJsonValue
    });
    return { appointment };
  }

  private async resolveAiReminderDueAt(businessId: string) {
    const settings = await this.settings.getByBusiness(businessId);
    return defaultAiReminderDueAt(settings.timezone);
  }
}
