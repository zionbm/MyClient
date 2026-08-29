import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

type Customer = { id: string; name: string; phone?: string | null; email?: string | null; address?: string | null } | null | undefined;
type Reminder = { id: string; customerId?: string | null; title: string; description?: string | null; priority: string; dueAt?: Date | null; status: string; source: string; sourceRef?: string | null; createdAt: Date; updatedAt: Date; customer?: Customer };
type Visit = { id: string; customerId?: string | null; title: string; location?: string | null; notes?: string | null; startsAt: Date; endsAt?: Date | null; status: string; createdAt: Date; updatedAt: Date; customer?: Customer };
type Quote = { id: string; customerId?: string | null; title: string; description?: string | null; estimatedAmount?: Prisma.Decimal | null; dueAt: Date; status: string; source: string; sourceRef?: string | null; createdAt: Date; updatedAt: Date; customer?: Customer };

function customer(value: Customer) {
  return value ? { id: value.id, name: value.name, phone: value.phone ?? null, email: value.email ?? null, address: value.address ?? null, createdAt: null } : null;
}

@Injectable()
export class CoreWorkItemPresenter {
  reminder(value: Reminder) {
    return { id: value.id, customerId: value.customerId ?? null, title: value.title, description: value.description ?? null, priority: value.priority, dueAt: value.dueAt ?? null, status: value.status, source: value.source, sourceRef: value.sourceRef ?? null, customer: customer(value.customer), createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  reminderWorkItem(value: Reminder) {
    const item = this.reminder(value);
    return { id: item.id, type: "reminder", title: item.title, description: item.description, customer: item.customer, dueAt: item.dueAt ?? item.createdAt, priority: item.priority, status: item.status, source: item.source, linkedEntity: { type: "reminder", id: item.id }, actions: item.status === "DONE" ? ["open"] : ["call", "complete", "open"] };
  }
  homeVisit(value: Visit) {
    return { id: value.id, customerId: value.customerId ?? null, title: value.title, location: value.location ?? null, notes: value.notes ?? null, startsAt: value.startsAt, endsAt: value.endsAt ?? null, status: value.status, customer: customer(value.customer), createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  homeVisitWorkItem(value: Visit) {
    const item = this.homeVisit(value);
    return { id: item.id, type: "home_visit", title: item.title, description: item.notes ?? item.location, location: item.location, notes: item.notes, customer: item.customer, dueAt: item.startsAt, priority: "NORMAL", status: item.status, source: "app", linkedEntity: { type: "home_visit", id: item.id }, actions: item.status === "DONE" ? ["open"] : ["navigate", "complete", "open"] };
  }
  appointmentWorkItem(value: Visit) {
    return { id: value.id, type: "appointment", title: value.title, description: value.notes ?? value.location, location: value.location ?? null, notes: value.notes ?? null, customer: customer(value.customer), startsAt: value.startsAt, endsAt: value.endsAt ?? null, priority: "NORMAL", status: value.status, source: "app", linkedEntity: { type: "appointment", id: value.id }, actions: value.status === "DONE" ? ["open"] : ["complete", "open"] };
  }
  quote(value: Quote) {
    return { id: value.id, customerId: value.customerId ?? null, title: value.title, description: value.description ?? null, estimatedAmount: value.estimatedAmount?.toString() ?? null, dueAt: value.dueAt, status: value.status, source: value.source, sourceRef: value.sourceRef ?? null, customer: customer(value.customer), createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  quoteWorkItem(value: Quote) {
    const item = this.quote(value);
    return { id: item.id, type: "quote", title: item.title, description: item.description, customer: item.customer, dueAt: item.dueAt, priority: "NORMAL", status: item.status, source: item.source, linkedEntity: { type: "quote", id: item.id }, actions: item.status === "PAID" ? ["open"] : ["open", "edit", "mark_paid"] };
  }
}
