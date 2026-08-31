import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { VoiceCommandResult } from "@myclient/contracts";

type VoiceCommandExecutionResult = { status: string; results: Array<Record<string, unknown>>; };

@Injectable()
export class CoreVoiceResultPresenter {
  isInvalidTranscript(transcript: string): boolean {
    const normalized = transcript.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
    const visibleCharacters = normalized.replace(/\s+/g, "");
    return visibleCharacters.length < 2 ||
      normalized === "הקלטה של בעל עסק בעברית שמבקש ליצור משימה, לקוח, פגישה, עבודה או הערה במערכת CRM.";
  }

  fromStoredCommand(command: { transcript?: string | null; executionResult?: Prisma.JsonValue | null }): VoiceCommandResult {
    const execution = this.asRecord(command.executionResult);
    const storedResult = this.asRecord(execution.voiceResult);
    if (typeof storedResult.state === "string") {
      return storedResult as VoiceCommandResult;
    }
    if (typeof execution.status === "string" && Array.isArray(execution.results)) {
      return this.buildResult({
        transcript: command.transcript ?? null,
        execution: {
          status: execution.status,
          results: execution.results.filter((result): result is Record<string, unknown> => typeof result === "object" && result !== null)
        },
        timeZone: "Asia/Jerusalem"
      });
    }

    return this.buildFailedResult({
      transcript: command.transcript ?? null,
      message: typeof execution.message === "string" ? execution.message : "Voice command execution failed"
    });
  }

  buildFailedResult(input: { transcript?: string | null; message: string }): VoiceCommandResult {
    const unclearRecording = input.message.includes("לא זוהה דיבור ברור") || !input.transcript;
    return {
      state: "failed",
      title: unclearRecording ? "לא הצלחתי להבין את ההקלטה" : "לא הצלחתי לבצע את הפקודה",
      summary: unclearRecording
        ? "אפשר להקליט שוב או להקליד את הפקודה."
        : "אפשר לבדוק את מה שנשמע, להקליט שוב או ליצור את הפעולה ידנית.",
      transcript: input.transcript ?? null,
      items: [],
      primaryAction: "הקלט שוב",
      secondaryActions: ["סגור"]
    };
  }

  buildResult(input: {
    transcript: string | null;
    execution: VoiceCommandExecutionResult;
    timeZone: string;
  }): VoiceCommandResult {
    const items = input.execution.results.map((result, index) => this.voiceResultItemFromExecutionResult(result, index, input.timeZone));
    if (items.length === 0) {
      return {
        state: "unsupported",
        title: "לא מצאתי פעולה מתאימה",
        summary: "אפשר לבקש ליצור לקוח, תזכורת, ביקור, הצעת מחיר או הערת לקוח.",
        transcript: input.transcript,
        items: [],
        primaryAction: "הקלט שוב",
        secondaryActions: ["סגור"]
      };
    }

    const pendingItems = items.filter((item) => item.status === "pending");
    const pendingCount = pendingItems.length;
    const missingPendingCount = pendingItems.filter((item) => item.missingFields.length > 0).length;
    const failedCount = items.filter((item) => item.status === "failed").length;
    const doneCount = items.length - pendingCount - failedCount;
    const state: VoiceCommandResult["state"] = missingPendingCount > 0
      ? "needs_input"
      : pendingCount > 0
        ? "needs_review"
        : failedCount === items.length
          ? "failed"
          : "done";

    return {
      state,
      title: state === "needs_input" ? "צריך עוד פרט" : state === "needs_review" ? "לאישור" : state === "failed" ? "לא הצלחתי לבצע את הפקודה" : "בוצע",
      summary: this.voiceResultSummary({ state, doneCount, pendingCount, failedCount }),
      transcript: input.transcript,
      items,
      primaryAction: "סגור",
      secondaryActions: state === "done" ? ["הקלט שוב"] : ["אשר מאוחר יותר", "הקלט שוב"]
    };
  }

  voiceResultSummary(input: {
    state: VoiceCommandResult["state"];
    doneCount: number;
    pendingCount: number;
    failedCount: number;
  }) {
    if (input.state === "needs_input") {
      if (input.doneCount > 0) {
        return `ביצעתי ${input.doneCount} ${input.doneCount === 1 ? "פעולה" : "פעולות"}. יש ${input.pendingCount} ${input.pendingCount === 1 ? "פעולה שצריכה" : "פעולות שצריכות"} השלמה.`;
      }
      return "הבנתי את הפעולה, אבל חסר פרט כדי להשלים אותה.";
    }
    if (input.state === "needs_review") {
      return input.pendingCount === 1
        ? "הבנתי את הפעולה. אפשר לפתוח, לערוך ולאשר לפני שהיא נשמרת."
        : `הבנתי ${input.pendingCount} פעולות. אפשר לפתוח כל כרטיס, לערוך ולאשר לפני שמירה.`;
    }
    if (input.state === "failed") {
      return "אפשר לבדוק את מה שנשמע, להקליט שוב או ליצור את הפעולה ידנית.";
    }
    return input.doneCount === 1 ? "ביצעתי פעולה אחת מהפקודה הקולית." : `ביצעתי ${input.doneCount} פעולות מהפקודה הקולית.`;
  }

  voiceResultItemFromExecutionResult(result: Record<string, unknown>, index: number, timeZone: string): VoiceCommandResult["items"][number] {
    const actionType = typeof result.actionType === "string" ? result.actionType : "ACTION";
    const status = result.status === "PENDING" ? "pending" : result.status === "EXECUTED" ? "created" : "failed";
    const executionPayload = this.asRecord(result.result);
    const aiPendingAction = this.asRecord(result.aiPendingAction);
    const payload = this.asRecord(aiPendingAction.payload);
    const entity = this.voiceResultEntity(executionPayload);
    const fields = status === "pending"
      ? this.voicePendingFields(actionType, payload, aiPendingAction, timeZone)
      : this.voiceEntityFields(actionType, entity, timeZone);

    return {
      id: typeof result.idempotencyKey === "string" ? result.idempotencyKey : `${actionType}:${index}`,
      actionType,
      kind: this.voiceResultKind(actionType, payload),
      status,
      title: this.voiceResultTitle(actionType, status, payload),
      subtitle: status === "pending" ? this.pendingReason(aiPendingAction) : undefined,
      payload: status === "pending" ? payload : entity,
      fields,
      entityId: typeof entity.id === "string" ? entity.id : undefined,
      aiPendingActionId: typeof aiPendingAction.id === "string" ? aiPendingAction.id : undefined,
      missingFields: this.stringList(aiPendingAction.missingFields)
    };
  }

  voiceResultEntity(result: Record<string, unknown>) {
    for (const value of [result.customer, result.reminder, result.homeVisit, result.appointment, result.quote, result.note, result.item]) {
      const record = this.asRecord(value);
      if (Object.keys(record).length > 0) return record;
    }
    return result;
  }

  voiceResultKind(actionType: string, payload: Record<string, unknown> = {}): VoiceCommandResult["items"][number]["kind"] {
    if (actionType === "DELETE_WORK_ITEM") {
      const itemType = typeof payload.itemType === "string" ? payload.itemType : undefined;
      if (itemType === "reminder" || itemType === "home_visit" || itemType === "appointment" || itemType === "quote" || itemType === "note") {
        return itemType;
      }
    }
    if (actionType.includes("CUSTOMER") && !actionType.includes("NOTE")) return "customer";
    if (actionType.includes("HOME_VISIT")) return "home_visit";
    if (actionType.includes("APPOINTMENT")) return "appointment";
    if (actionType.includes("QUOTE")) return "quote";
    if (actionType.includes("NOTE")) return "note";
    if (actionType.includes("REMINDER")) return "reminder";
    return "action";
  }

  voiceResultTitle(
    actionType: string,
    status: VoiceCommandResult["items"][number]["status"],
    payload: Record<string, unknown> = {}
  ) {
    const prefix = status === "pending" ? "" : status === "completed" ? "הושלם: " : "";
    if (status === "pending") {
      if (actionType === "CREATE_CUSTOMER") return "לקוח חדש";
      if (actionType === "CREATE_REMINDER") return "תזכורת חדשה";
      if (actionType === "CREATE_HOME_VISIT") return "ביקור בית חדש";
      if (actionType === "CREATE_APPOINTMENT") return "פגישה חדשה";
      if (actionType === "COMPLETE_APPOINTMENT") return "סיום פגישה";
      if (actionType === "CANCEL_APPOINTMENT") return "ביטול פגישה";
      if (actionType === "CREATE_QUOTE") return "הצעת מחיר חדשה";
      if (actionType === "MARK_QUOTE_PAID") return "סגירת הצעת מחיר";
      if (actionType === "CANCEL_QUOTE") return "ביטול הצעת מחיר";
      if (actionType === "DELETE_WORK_ITEM") {
        const itemType = typeof payload.itemType === "string" ? payload.itemType : undefined;
        return itemType === "quote"
          ? "מחיקת הצעת מחיר"
          : itemType === "appointment"
            ? "מחיקת פגישה"
            : itemType === "home_visit"
              ? "מחיקת ביקור בית"
              : itemType === "reminder"
                ? "מחיקת תזכורת"
                : "מחיקת פריט עבודה";
      }
    }
    if (actionType.includes("CUSTOMER") && !actionType.includes("NOTE")) return `${prefix}לקוח`;
    if (actionType.includes("HOME_VISIT")) return `${prefix}ביקור בית`;
    if (actionType.includes("APPOINTMENT")) return `${prefix}פגישה`;
    if (actionType.includes("QUOTE")) return `${prefix}הצעת מחיר`;
    if (actionType.includes("NOTE")) return `${prefix}הערת לקוח`;
    if (actionType.includes("REMINDER")) return `${prefix}תזכורת`;
    return `${prefix}פעולה`;
  }

  voicePendingFields(actionType: string, payload: Record<string, unknown>, aiPendingAction: Record<string, unknown>, timeZone: string) {
    const missingFields = new Set(this.stringList(aiPendingAction.missingFields));
    const fields = this.voiceEntityFields(actionType, payload, timeZone);
    for (const field of missingFields) {
      if (!fields.some((item) => item.label === this.voiceFieldLabel(field))) {
        fields.push({ label: this.voiceFieldLabel(field), value: "חסר", state: "missing" as const });
      }
    }
    return fields.map((field) => missingFields.has(this.fieldKeyFromHebrewLabel(field.label)) ? { ...field, state: "missing" as const, value: field.value || "חסר" } : field);
  }

  voiceEntityFields(actionType: string, entity: Record<string, unknown>, timeZone: string): VoiceCommandResult["items"][number]["fields"] {
    const fields: VoiceCommandResult["items"][number]["fields"] = [];
    const isCustomerAction = actionType.includes("CUSTOMER") && !actionType.includes("NOTE");
    const isWorkItemAction = actionType.includes("REMINDER") ||
      actionType.includes("HOME_VISIT") ||
      actionType.includes("APPOINTMENT") ||
      actionType.includes("QUOTE");
    const title = isCustomerAction
      ? this.stringValue(entity.name)
      : this.stringValue(entity.title) ?? this.stringValue(entity.text);
    if (title) fields.push({ label: isCustomerAction ? "שם" : "נושא", value: title, state: "normal" });
    const phone = this.stringValue(entity.phone);
    if (phone) fields.push({ label: "טלפון", value: phone, state: "normal" });
    const customerName = this.stringValue(this.asRecord(entity.customer).name) ??
      this.stringValue(entity.customerName) ??
      (isWorkItemAction ? this.stringValue(entity.name) : undefined);
    if (customerName) fields.push({ label: "לקוח", value: customerName, state: "normal" });
    const dueAt = this.stringValue(entity.dueAt) ?? this.stringValue(entity.startsAt);
    if (dueAt) fields.push({ label: "מועד", value: this.formatVoiceDate(dueAt, timeZone), state: "normal" });
    const amount = this.stringValue(entity.estimatedAmount);
    if (amount) fields.push({ label: "סכום", value: amount, state: "normal" });
    const location = this.stringValue(entity.location) ?? this.stringValue(entity.address);
    if (location) fields.push({ label: "כתובת", value: location, state: "normal" });
    return fields;
  }

  pendingReason(aiPendingAction: Record<string, unknown>) {
    const reviewReason = this.stringValue(aiPendingAction.reviewReason);
    if (reviewReason) return reviewReason;
    const missingFields = this.stringList(aiPendingAction.missingFields).map((field) => this.voiceFieldLabel(field));
    return missingFields.length > 0 ? `חסר: ${missingFields.join(", ")}` : "ממתין לאישור";
  }

  voiceFieldLabel(field: string) {
    const labels: Record<string, string> = {
      customerId: "לקוח",
      customerName: "לקוח",
      reminderId: "תזכורת",
      appointmentId: "פגישה",
      homeVisitId: "ביקור בית",
      quoteId: "הצעת מחיר",
      title: "נושא",
      text: "תוכן",
      name: "שם",
      phone: "טלפון",
      dueAt: "מועד",
      startsAt: "מועד",
      estimatedAmount: "סכום",
      location: "כתובת"
    };
    return labels[field] ?? field;
  }

  fieldKeyFromHebrewLabel(label: string) {
    const labels: Record<string, string> = {
      לקוח: "customerId",
      תזכורת: "reminderId",
      ביקור: "homeVisitId",
      "הצעת מחיר": "quoteId",
      נושא: "title",
      תוכן: "text",
      שם: "name",
      טלפון: "phone",
      מועד: "dueAt",
      סכום: "estimatedAmount",
      כתובת: "location"
    };
    return labels[label] ?? label;
  }

  formatVoiceDate(value: string, timeZone: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("he-IL", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  stringValue(value: unknown) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Prisma.Decimal) return value.toString();
    return undefined;
  }

  stringList(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  }

  asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
