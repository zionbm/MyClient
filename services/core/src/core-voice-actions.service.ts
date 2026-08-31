import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AiAction } from "@myclient/contracts";
import {
  AiPendingActionsRepository,
  AppointmentsRepository,
  AuditRepository,
  BusinessSettingsRepository,
  CustomersRepository,
  HomeVisitsRepository,
  QuotesRepository,
  RemindersRepository
} from "./core.repositories.js";
import {
  defaultAiReminderDueAt,
  parseAiDueAt,
  parseHebrewRelativeDueAt,
  parseHebrewVoiceDueAt,
  tryParseAiDueAt
} from "./core-utils.js";

@Injectable()
export class CoreVoiceActionsService {
  constructor(
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(CustomersRepository) private readonly customers: CustomersRepository,
    @Inject(RemindersRepository) private readonly reminders: RemindersRepository,
    @Inject(AppointmentsRepository) private readonly appointments: AppointmentsRepository,
    @Inject(HomeVisitsRepository) private readonly homeVisits: HomeVisitsRepository,
    @Inject(QuotesRepository) private readonly quotes: QuotesRepository,
    @Inject(AiPendingActionsRepository) private readonly aiPendingActions: AiPendingActionsRepository
  ) {}

  async createPendingActionsFromVoiceCommand(input: {
    businessId: string;
    userId: string;
    transcript: string;
    actions: AiAction[];
  }) {
    const results = [];
    const settings = await this.settings.getByBusiness(input.businessId);
    const actions = this.applyVoiceCustomerAddressHints(
      this.correctVoiceActionIntents(input.actions, input.transcript),
      input.transcript
    );

    for (const action of actions) {
      let payload = this.resolveCreatedCustomerReference(action.payload, []);
      payload = this.enrichVoiceActionPayload(action, payload, input.transcript, settings.timezone);
      payload = this.normalizeVoiceActionPayload(action.type, payload);
      payload = await this.resolveVoiceActionReferences({
        businessId: input.businessId,
        actionType: action.type,
        payload,
        transcript: input.transcript
      });
      const missingFields = this.requiredVoiceMissingFields(action, payload);
      const aiPendingAction = await this.aiPendingActions.create({
        businessId: input.businessId,
        userId: input.userId,
        actionType: action.type,
        payload: payload as Prisma.InputJsonValue,
        missingFields,
        reviewReason: this.voiceReferenceReviewReason(action.type, payload)
      });
      await this.audit.record({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        source: "owner_voice_command",
        entityType: "ai_pending_action",
        entityId: aiPendingAction.id,
        action: "CREATE_AI_PENDING_ACTION_FROM_VOICE_COMMAND",
        after: aiPendingAction as Prisma.InputJsonValue
      });
      results.push({ status: "PENDING", actionType: action.type, idempotencyKey: action.idempotencyKey, aiPendingAction });
    }

    const hasPending = results.some((result) => result.status === "PENDING");
    return {
      status: hasPending ? "PARTIAL_PENDING" : "EXECUTED",
      results
    };
  }

  async preparePayloadForApproval(input: {
    businessId: string;
    actionType: string;
    payload: Record<string, unknown>;
  }) {
    const normalized = this.normalizeVoiceActionPayload(input.actionType, input.payload);
    return this.resolveVoiceActionReferences({
      businessId: input.businessId,
      actionType: input.actionType,
      payload: normalized,
      transcript: ""
    });
  }

  async resolveAiReminderDueAt(businessId: string, payload: Record<string, unknown>) {
    const settings = await this.settings.getByBusiness(businessId);
    if (typeof payload.dueAt === "string") {
      return parseAiDueAt(payload.dueAt, settings.timezone);
    }

    return defaultAiReminderDueAt(settings.timezone);
  }

  private correctVoiceActionIntents(actions: AiAction[], transcript: string): AiAction[] {
    const normalizedTranscript = this.normalizedVoiceReference(transcript);
    const mentionsAppointment = normalizedTranscript?.includes("פגישה") ?? false;
    const mentionsHomeVisit = normalizedTranscript?.includes("ביקור בית") ?? false;
    const mentionsReminder = normalizedTranscript?.includes("תזכורת") ?? false;
    const mentionsQuote = normalizedTranscript?.includes("הצעת מחיר") ?? false;
    const completesItem = /(?:תסגור|סגור|תסיים|סיים|סיימתי|בוצעה|הסתיימה|נסגרה|שולמה)/.test(transcript);
    const cancelsAppointment = mentionsAppointment && /(?:תבטל|בטל|ביטול)/.test(transcript);
    const cancelsQuote = mentionsQuote && /(?:תבטל|בטל|ביטול|לא רלוונטית)/.test(transcript);
    const deletesItem = /(?:תמחק|מחק|מחיקה)/.test(transcript) &&
      (mentionsAppointment || mentionsHomeVisit || mentionsReminder || mentionsQuote);
    const completion = completesItem
      ? mentionsAppointment
        ? { type: "COMPLETE_APPOINTMENT" as const, idField: "appointmentId", actionFragment: "APPOINTMENT" }
        : mentionsHomeVisit
          ? { type: "COMPLETE_HOME_VISIT" as const, idField: "homeVisitId", actionFragment: "HOME_VISIT" }
          : mentionsReminder
            ? { type: "COMPLETE_REMINDER" as const, idField: "reminderId", actionFragment: "REMINDER" }
            : mentionsQuote
              ? { type: "MARK_QUOTE_PAID" as const, idField: "quoteId", actionFragment: "QUOTE" }
              : null
      : null;

    if (!completion && !cancelsAppointment && !cancelsQuote && !deletesItem) {
      return actions;
    }

    return actions.map((action) => {
      const itemType = mentionsAppointment
        ? "appointment"
        : mentionsHomeVisit
          ? "home_visit"
          : mentionsReminder
            ? "reminder"
            : "quote";
      const actionFragment = deletesItem
        ? itemType === "home_visit"
          ? "HOME_VISIT"
          : itemType.toUpperCase()
        : cancelsAppointment
          ? "APPOINTMENT"
          : cancelsQuote
            ? "QUOTE"
            : completion?.actionFragment;
      if (actionFragment && !action.type.includes(actionFragment) && actions.length !== 1) {
        return action;
      }
      const type = deletesItem
        ? "DELETE_WORK_ITEM"
        : cancelsAppointment
          ? "CANCEL_APPOINTMENT"
          : cancelsQuote
            ? "CANCEL_QUOTE"
            : completion!.type;
      const idField = deletesItem
        ? "itemId"
        : cancelsAppointment
          ? "appointmentId"
          : cancelsQuote
            ? "quoteId"
            : completion!.idField;
      const missingFields = [...new Set([
        ...action.missingFields.filter((field) =>
          field !== "startsAt" &&
          field !== "title" &&
          (!deletesItem || !["reminderId", "appointmentId", "homeVisitId", "quoteId"].includes(field))
        ),
        ...(deletesItem ? ["itemType"] : []),
        idField
      ])];
      const payload = { ...action.payload };
      if (action.type.startsWith("CREATE_")) {
        delete payload.title;
        delete payload.description;
        delete payload.dueAt;
        delete payload.startsAt;
        delete payload.endsAt;
      }
      if (deletesItem) {
        const typedIdField = itemType === "reminder"
          ? "reminderId"
          : itemType === "appointment"
            ? "appointmentId"
            : itemType === "home_visit"
              ? "homeVisitId"
              : "quoteId";
        if (typeof payload[typedIdField] === "string") {
          payload.itemId = payload[typedIdField];
        }
        delete payload.reminderId;
        delete payload.appointmentId;
        delete payload.homeVisitId;
        delete payload.quoteId;
        payload.itemType = itemType;
      }
      return {
        ...action,
        type,
        payload,
        requiresConfirmation: deletesItem || cancelsAppointment || cancelsQuote || action.requiresConfirmation,
        missingFields
      };
    });
  }

  private applyVoiceCustomerAddressHints(actions: AiAction[], transcript: string): AiAction[] {
    const oneOffLocationHint = /(?:אתר|אתר עבודה|דירה להשכרה|אצל אמא|אצל אימא|אצל אבא|אצל ההורים|במשרד|בעסק|במחסן)/.test(transcript);
    if (oneOffLocationHint) {
      return actions;
    }

    return actions.map((action, index) => {
      if (action.type !== "CREATE_CUSTOMER" || typeof action.payload.address === "string") {
        return action;
      }

      const name = this.normalizedVoiceText(action.payload.name);
      const phone = this.normalizedVoiceText(action.payload.phone);
      if (!name && !phone) {
        return action;
      }

      const laterLocation = actions.slice(index + 1)
        .map((candidate) => ({
          type: candidate.type,
          payload: this.normalizeVoiceActionPayload(candidate.type, candidate.payload)
        }))
        .find((candidate) => {
          if (candidate.type !== "CREATE_HOME_VISIT" && candidate.type !== "CREATE_APPOINTMENT") {
            return false;
          }
          const candidateName = this.normalizedVoiceText(candidate.payload.name);
          const candidatePhone = this.normalizedVoiceText(candidate.payload.phone);
          return (name && candidateName === name) || (phone && candidatePhone === phone);
        })?.payload.location;

      return typeof laterLocation === "string"
        ? { ...action, payload: { ...action.payload, address: laterLocation } }
        : action;
    });
  }

  private resolveCreatedCustomerReference(
    payload: Record<string, unknown>,
    createdCustomers: Array<{ id: string; name?: string | null; phone?: string | null }>
  ): Record<string, unknown> {
    if (typeof payload.customerId === "string" || createdCustomers.length === 0) {
      return payload;
    }

    const phone = typeof payload.phone === "string" ? payload.phone : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const matchingCustomer = createdCustomers.find((customer) =>
      (phone && customer.phone === phone) || (name && customer.name === name)
    ) ?? createdCustomers.at(-1);

    return matchingCustomer ? { ...payload, customerId: matchingCustomer.id } : payload;
  }

  private normalizeVoiceActionPayload(actionType: string, payload: Record<string, unknown>) {
    const normalized = { ...payload };

    if (actionType === "CREATE_HOME_VISIT" ||
      actionType === "UPDATE_HOME_VISIT" ||
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "UPDATE_APPOINTMENT") {
      if (typeof normalized.location !== "string" && typeof normalized.address === "string") {
        normalized.location = normalized.address;
      }
      if (typeof normalized.notes !== "string" && typeof normalized.description === "string") {
        normalized.notes = normalized.description;
      }
      if (typeof normalized.title !== "string") {
        normalized.title = typeof normalized.notes === "string"
          ? `ביקור בית - ${normalized.notes}`
          : actionType === "CREATE_HOME_VISIT" || actionType === "UPDATE_HOME_VISIT"
            ? "ביקור בית"
            : "פגישה";
      }
    }

    if (actionType === "CREATE_REMINDER" &&
      typeof normalized.title !== "string" &&
      typeof normalized.text === "string") {
      normalized.title = normalized.text;
    }

    if ((actionType === "CREATE_QUOTE" || actionType === "UPDATE_QUOTE") &&
      typeof normalized.title !== "string") {
      const description = typeof normalized.description === "string" ? normalized.description : undefined;
      const subject = description?.match(/(?:על|עבור)\s+(.+)$/)?.[1]?.trim();
      if (subject) {
        normalized.title = subject;
      }
    }

    if (actionType === "CREATE_NOTE" &&
      typeof normalized.text !== "string" &&
      typeof normalized.description === "string") {
      normalized.text = normalized.description;
    }

    return normalized;
  }

  private async resolveVoiceActionReferences(input: {
    businessId: string;
    actionType: string;
    payload: Record<string, unknown>;
    transcript: string;
  }): Promise<Record<string, unknown>> {
    let payload = this.withVoiceCustomerNameHint(input.payload, input.transcript);

    if (this.voiceActionNeedsCustomer(input.actionType, payload)) {
      const customerMatches = await this.resolveVoiceCustomers(input.businessId, payload, input.transcript);
      if (customerMatches.length === 1) {
        payload = {
          ...payload,
          customerId: customerMatches[0].id,
          customerName: customerMatches[0].name
        };
      } else if (customerMatches.length > 1) {
        payload = {
          ...payload,
          customerName: typeof payload.customerName === "string"
            ? payload.customerName
            : [...new Set(customerMatches.map((customer) => customer.name))].join(" / ")
        };
      }
    }

    if (input.actionType === "DELETE_WORK_ITEM" && typeof payload.itemId !== "string") {
      const itemType = typeof payload.itemType === "string" ? payload.itemType : undefined;
      const item = itemType === "reminder"
        ? await this.resolveVoiceReminder(input.businessId, payload, input.transcript)
        : itemType === "appointment"
          ? await this.resolveVoiceAppointment(input.businessId, payload, input.transcript)
          : itemType === "home_visit"
            ? await this.resolveVoiceHomeVisit(input.businessId, payload, input.transcript)
            : itemType === "quote"
              ? await this.resolveVoiceQuote(input.businessId, payload, input.transcript)
              : null;
      if (item && "id" in item) {
        payload = { ...payload, itemId: item.id };
      }
    }

    if (this.voiceActionNeedsReminder(input.actionType, payload)) {
      const reminder = await this.resolveVoiceReminder(input.businessId, payload, input.transcript);
      if (reminder) {
        payload = { ...payload, reminderId: reminder.id };
      }
    }

    if (this.voiceActionNeedsAppointment(input.actionType, payload)) {
      const appointment = await this.resolveVoiceAppointment(input.businessId, payload, input.transcript);
      if (appointment) {
        payload = { ...payload, appointmentId: appointment.id };
      }
    }

    if (this.voiceActionNeedsHomeVisit(input.actionType, payload)) {
      const homeVisit = await this.resolveVoiceHomeVisit(input.businessId, payload, input.transcript);
      if (homeVisit) {
        payload = { ...payload, homeVisitId: homeVisit.id };
      }
    }

    if (this.voiceActionNeedsQuote(input.actionType, payload)) {
      const quote = await this.resolveVoiceQuote(input.businessId, payload, input.transcript);
      if (quote) {
        payload = { ...payload, quoteId: quote.id };
      }
    }

    return payload;
  }

  private voiceActionNeedsCustomer(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.customerId === "string") {
      return false;
    }
    return actionType === "UPDATE_CUSTOMER" ||
      actionType === "CREATE_NOTE" ||
      actionType === "CREATE_REMINDER" ||
      actionType === "CREATE_HOME_VISIT" ||
      actionType === "UPDATE_HOME_VISIT" ||
      actionType === "COMPLETE_HOME_VISIT" ||
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "UPDATE_APPOINTMENT" ||
      actionType === "COMPLETE_APPOINTMENT" ||
      actionType === "CANCEL_APPOINTMENT" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "UPDATE_QUOTE" ||
      actionType === "MARK_QUOTE_PAID" ||
      actionType === "CANCEL_QUOTE" ||
      actionType === "DELETE_WORK_ITEM" ||
      actionType === "UPDATE_REMINDER" ||
      actionType === "COMPLETE_REMINDER";
  }

  private voiceActionNeedsReminder(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.reminderId === "string") {
      return false;
    }
    return actionType === "COMPLETE_REMINDER";
  }

  private voiceActionNeedsAppointment(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.appointmentId === "string") {
      return false;
    }
    return actionType === "UPDATE_APPOINTMENT" ||
      actionType === "COMPLETE_APPOINTMENT" ||
      actionType === "CANCEL_APPOINTMENT";
  }

  private voiceActionNeedsHomeVisit(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.homeVisitId === "string") {
      return false;
    }
    return actionType === "UPDATE_HOME_VISIT" || actionType === "COMPLETE_HOME_VISIT";
  }

  private voiceActionNeedsQuote(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.quoteId === "string") {
      return false;
    }
    return actionType === "UPDATE_QUOTE" ||
      actionType === "MARK_QUOTE_PAID" ||
      actionType === "CANCEL_QUOTE";
  }

  private async resolveVoiceCustomers(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const phone = this.normalizedVoiceText(payload.phone);
    const email = this.normalizedVoiceText(payload.email);
    const name = this.normalizedVoiceReference(payload.customerName ?? payload.name);

    if (phone) {
      const byPhone = await this.findUniqueVoiceCustomer(businessId, { phone });
      if (byPhone) return [byPhone];
    }

    if (email) {
      const byEmail = await this.findUniqueVoiceCustomer(businessId, { email });
      if (byEmail) return [byEmail];
    }

    const customers = await this.customers.listForVoiceReferenceMatch(businessId);
    if (name) {
      return customers.filter((customer) => this.normalizedVoiceReference(customer.name) === name);
    }

    const normalizedTranscript = this.normalizedVoiceReference(transcript);
    if (!normalizedTranscript) {
      return [];
    }
    const mentioned = customers.filter((customer) => {
      const normalizedName = this.normalizedVoiceReference(customer.name);
      return Boolean(normalizedName && normalizedName.length >= 2 && this.voiceTranscriptMentionsName(normalizedTranscript, normalizedName));
    });
    if (mentioned.length <= 1) {
      return mentioned;
    }
    const longestNameLength = Math.max(...mentioned.map((customer) => this.normalizedVoiceReference(customer.name)?.length ?? 0));
    return mentioned.filter((customer) => this.normalizedVoiceReference(customer.name)?.length === longestNameLength);
  }

  private async findUniqueVoiceCustomer(
    businessId: string,
    criteria: { phone?: string; email?: string; name?: string }
  ) {
    return this.customers.findUniqueForVoiceMatch(businessId, criteria);
  }

  private async resolveVoiceReminder(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    if (typeof payload.customerName === "string" && !customerId) {
      return null;
    }
    const title = this.normalizedVoiceText(payload.title);
    const text = this.normalizedVoiceText(payload.text);
    const lookupText = this.normalizedVoiceText([title, text, transcript].filter(Boolean).join(" "));

    const reminders = await this.reminders.listOpenForVoiceMatch(businessId, customerId);

    if (reminders.length === 1) {
      return reminders[0];
    }

    const matchingReminders = reminders.filter((reminder) => {
      const normalizedTitle = this.normalizedVoiceText(reminder.title);
      const haystack = this.normalizedVoiceText([
        reminder.title,
        reminder.description,
        reminder.customer?.name,
        reminder.customer?.phone
      ].filter(Boolean).join(" "));
      return Boolean(lookupText && haystack && (
        lookupText.includes(haystack) ||
        haystack.includes(lookupText) ||
        normalizedTitle && lookupText.includes(normalizedTitle)
      ));
    });

    return matchingReminders.length === 1 ? matchingReminders[0] : null;
  }

  private async resolveVoiceAppointment(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    if (typeof payload.customerName === "string" && !customerId) {
      return null;
    }
    const lookupText = this.normalizedVoiceReference([
      payload.title,
      payload.notes,
      transcript
    ].filter((value): value is string => typeof value === "string").join(" "));
    const appointments = await this.appointments.listOpenForVoiceMatch(businessId, customerId);

    if (appointments.length === 1) {
      return appointments[0];
    }

    const matchingAppointments = appointments.filter((appointment) => {
      const normalizedTitle = this.normalizedVoiceReference(appointment.title);
      return Boolean(normalizedTitle && lookupText?.includes(normalizedTitle));
    });
    return matchingAppointments.length === 1 ? matchingAppointments[0] : null;
  }

  private async resolveVoiceHomeVisit(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    if (typeof payload.customerName === "string" && !customerId) {
      return null;
    }
    const visits = await this.homeVisits.listOpenForVoiceMatch(businessId, customerId);
    return this.resolveUniqueVoiceWorkItem(visits, payload, transcript);
  }

  private async resolveVoiceQuote(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
    if (typeof payload.customerName === "string" && !customerId) {
      return null;
    }
    const quotes = await this.quotes.listOpenForVoiceMatch(businessId, customerId);
    return this.resolveUniqueVoiceWorkItem(quotes, payload, transcript);
  }

  private resolveUniqueVoiceWorkItem<T extends { title: string }>(items: T[], payload: Record<string, unknown>, transcript: string) {
    if (items.length === 1) {
      return items[0];
    }
    const lookupText = this.normalizedVoiceReference([
      payload.title,
      payload.description,
      payload.notes,
      transcript
    ].filter((value): value is string => typeof value === "string").join(" "));
    const matchingItems = items.filter((item) => {
      const normalizedTitle = this.normalizedVoiceReference(item.title);
      return Boolean(normalizedTitle && lookupText?.includes(normalizedTitle));
    });
    return matchingItems.length === 1 ? matchingItems[0] : null;
  }

  private normalizedVoiceText(value: unknown) {
    return typeof value === "string" ? value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : undefined;
  }

  private withVoiceCustomerNameHint(payload: Record<string, unknown>, transcript: string) {
    if (typeof payload.customerName === "string" || typeof payload.name === "string") {
      return payload;
    }
    const customerName = transcript.match(/(?:אצל|עם)\s+(.+?)(?:\s+(?:עוד|בעוד|מחר|היום|בשעה|בתאריך)|[.!?]|$)/)?.[1]?.trim() ??
      transcript.match(/להתקשר\s+ל(.+?)(?:\s+(?:עוד|בעוד|מחר|היום|בשעה|בתאריך)|[.!?]|$)/)?.[1]?.trim();
    return customerName ? { ...payload, customerName } : payload;
  }

  private normalizedVoiceReference(value: unknown) {
    return typeof value === "string"
      ? value
        .normalize("NFKD")
        .replace(/[\p{M}\p{Cf}]/gu, "")
        .replace(/['’‘`´׳״"]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase("he-IL")
      : undefined;
  }

  private voiceTranscriptMentionsName(transcript: string, name: string) {
    return transcript === name ||
      transcript.startsWith(`${name} `) ||
      transcript.endsWith(` ${name}`) ||
      transcript.includes(` ${name} `) ||
      transcript.startsWith(`ל${name} `) ||
      transcript.endsWith(` ל${name}`) ||
      transcript.includes(` ל${name} `);
  }

  private enrichVoiceActionPayload(action: AiAction, payload: Record<string, unknown>, transcript: string, timeZone: string) {
    const normalized = { ...payload };

    if (this.voiceActionUsesDueAt(action.type)) {
      const dueAt = this.normalizeVoiceDateValue(normalized.dueAt, transcript, timeZone);
      if (dueAt) {
        normalized.dueAt = dueAt.toISOString();
      } else if (typeof normalized.dueAt === "string") {
        delete normalized.dueAt;
      }
    }

    if (this.voiceActionUsesStartsAt(action.type)) {
      const startsAt = this.normalizeVoiceDateValue(normalized.startsAt, transcript, timeZone);
      if (startsAt) {
        normalized.startsAt = startsAt.toISOString();
      } else if (typeof normalized.startsAt === "string") {
        delete normalized.startsAt;
      }

      const endsAt = typeof normalized.endsAt === "string"
        ? tryParseAiDueAt(normalized.endsAt, timeZone)
        : undefined;
      if (endsAt) {
        normalized.endsAt = endsAt.toISOString();
      } else if (typeof normalized.endsAt === "string") {
        delete normalized.endsAt;
      }
    }

    if ((action.type === "CREATE_QUOTE" || action.type === "UPDATE_QUOTE") &&
      typeof normalized.title !== "string") {
      const subject = transcript.match(/(?:על|עבור)\s+(.+?)(?:[.!?。]|$)/)?.[1]?.trim();
      if (subject) {
        normalized.title = subject;
      }
    }

    return normalized;
  }

  private normalizeVoiceDateValue(value: unknown, transcript: string, timeZone: string) {
    const relativeFromTranscript = parseHebrewRelativeDueAt(transcript);
    if (relativeFromTranscript) {
      return relativeFromTranscript;
    }

    if (typeof value === "string") {
      const parsed = tryParseAiDueAt(value, timeZone);
      if (parsed) {
        return parsed;
      }
      const parsedFromValue = parseHebrewVoiceDueAt(value, timeZone);
      if (parsedFromValue) {
        return parsedFromValue;
      }
    }

    return parseHebrewVoiceDueAt(transcript, timeZone);
  }

  private voiceActionUsesDueAt(actionType: string) {
    return actionType === "CREATE_REMINDER" ||
      actionType === "UPDATE_REMINDER" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "UPDATE_QUOTE";
  }

  private voiceActionUsesStartsAt(actionType: string) {
    return actionType === "CREATE_APPOINTMENT" ||
      actionType === "UPDATE_APPOINTMENT" ||
      actionType === "CREATE_HOME_VISIT" ||
      actionType === "UPDATE_HOME_VISIT";
  }

  private requiredVoiceMissingFields(action: AiAction, payload: Record<string, unknown>) {
    const fields = new Set(action.missingFields);
    if (typeof payload.customerName === "string" && payload.customerId === undefined) {
      fields.add("customerId");
    }
    if ((action.type === "COMPLETE_APPOINTMENT" || action.type === "CANCEL_APPOINTMENT") && payload.appointmentId === undefined) {
      fields.add("appointmentId");
    }
    if (action.type === "COMPLETE_HOME_VISIT" && payload.homeVisitId === undefined) {
      fields.add("homeVisitId");
    }
    if ((action.type === "MARK_QUOTE_PAID" || action.type === "CANCEL_QUOTE") && payload.quoteId === undefined) {
      fields.add("quoteId");
    }
    if (action.type === "DELETE_WORK_ITEM") {
      if (payload.itemType === undefined) fields.add("itemType");
      if (payload.itemId === undefined) fields.add("itemId");
    }
    if (this.voiceActionUsesStartsAt(action.type) && payload.startsAt === undefined) {
      fields.add("startsAt");
    }
    if ((action.type === "CREATE_QUOTE" || action.type === "UPDATE_QUOTE") && payload.title === undefined) {
      fields.add("title");
    }
    return [...fields].filter((field) => !this.isOptionalVoiceField(action.type, field) && payload[field] === undefined);
  }

  private voiceReferenceReviewReason(actionType: string, payload: Record<string, unknown>) {
    const customerName = typeof payload.customerName === "string" ? payload.customerName : undefined;
    if (customerName && typeof payload.customerId !== "string") {
      return `לא מצאתי לקוח יחיד שמתאים לשם "${customerName}".`;
    }

    const target = actionType === "COMPLETE_REMINDER" && typeof payload.reminderId !== "string"
      ? "תזכורת פתוחה"
      : (actionType === "COMPLETE_APPOINTMENT" || actionType === "CANCEL_APPOINTMENT") && typeof payload.appointmentId !== "string"
        ? "פגישה פתוחה"
        : actionType === "COMPLETE_HOME_VISIT" && typeof payload.homeVisitId !== "string"
          ? "ביקור בית פתוח"
          : (actionType === "MARK_QUOTE_PAID" || actionType === "CANCEL_QUOTE") && typeof payload.quoteId !== "string"
            ? "הצעת מחיר פתוחה"
            : actionType === "DELETE_WORK_ITEM" && typeof payload.itemId !== "string"
              ? this.voiceWorkItemLabel(payload.itemType)
            : undefined;
    if (!target) {
      return undefined;
    }
    return customerName
      ? `לא מצאתי ${target} יחיד שמתאים ללקוח ${customerName}.`
      : `לא מצאתי ${target} יחיד שמתאים לפקודה.`;
  }

  private voiceWorkItemLabel(itemType: unknown) {
    return itemType === "quote"
      ? "הצעת מחיר פתוחה"
      : itemType === "appointment"
        ? "פגישה פתוחה"
        : itemType === "home_visit"
          ? "ביקור בית פתוח"
          : itemType === "reminder"
            ? "תזכורת פתוחה"
            : "פריט עבודה מתאים";
  }

  private isOptionalVoiceField(actionType: string, field: string) {
    if (field === "dueAt") {
      return actionType === "CREATE_REMINDER";
    }

    if (field === "phone") {
      return actionType === "CREATE_CUSTOMER" || actionType === "CREATE_REMINDER";
    }

    return false;
  }
}
