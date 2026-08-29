import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AiAction } from "@myclient/contracts";
import {
  AiPendingActionsRepository,
  AuditRepository,
  BusinessSettingsRepository,
  CustomersRepository,
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
    const actions = this.applyVoiceCustomerAddressHints(input.actions, input.transcript);

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
        missingFields
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
    let payload = input.payload;

    if (this.voiceActionNeedsCustomer(input.actionType, payload)) {
      const customer = await this.resolveVoiceCustomer(input.businessId, payload);
      if (customer) {
        payload = { ...payload, customerId: customer.id };
      }
    }

    if (this.voiceActionNeedsReminder(input.actionType, payload)) {
      const reminder = await this.resolveVoiceReminder(input.businessId, payload, input.transcript);
      if (reminder) {
        payload = { ...payload, reminderId: reminder.id };
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
      actionType === "CREATE_APPOINTMENT" ||
      actionType === "CREATE_QUOTE" ||
      actionType === "COMPLETE_REMINDER";
  }

  private voiceActionNeedsReminder(actionType: string, payload: Record<string, unknown>) {
    if (typeof payload.reminderId === "string") {
      return false;
    }
    return actionType === "COMPLETE_REMINDER";
  }

  private async resolveVoiceCustomer(businessId: string, payload: Record<string, unknown>) {
    const phone = this.normalizedVoiceText(payload.phone);
    const email = this.normalizedVoiceText(payload.email);
    const name = this.normalizedVoiceText(payload.name);

    if (phone) {
      const byPhone = await this.findUniqueVoiceCustomer(businessId, { phone });
      if (byPhone) return byPhone;
    }

    if (email) {
      const byEmail = await this.findUniqueVoiceCustomer(businessId, { email });
      if (byEmail) return byEmail;
    }

    if (name) {
      const byName = await this.findUniqueVoiceCustomer(businessId, { name });
      if (byName) return byName;
    }

    return null;
  }

  private async findUniqueVoiceCustomer(
    businessId: string,
    criteria: { phone?: string; email?: string; name?: string }
  ) {
    return this.customers.findUniqueForVoiceMatch(businessId, criteria);
  }

  private async resolveVoiceReminder(businessId: string, payload: Record<string, unknown>, transcript: string) {
    const customerId = typeof payload.customerId === "string" ? payload.customerId : undefined;
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

  private normalizedVoiceText(value: unknown) {
    return typeof value === "string" ? value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : undefined;
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
    if (this.voiceActionUsesStartsAt(action.type) && payload.startsAt === undefined) {
      fields.add("startsAt");
    }
    if ((action.type === "CREATE_QUOTE" || action.type === "UPDATE_QUOTE") && payload.title === undefined) {
      fields.add("title");
    }
    return [...fields].filter((field) => !this.isOptionalVoiceField(action.type, field) && payload[field] === undefined);
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
