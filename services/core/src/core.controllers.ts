import { Controller, Delete, Get, Inject, Patch, Post, Req, type Type } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { CoreService } from "./main.js";
import { CoreCustomersService } from "./core-customers.service.js";
import { CoreWorkItemsService } from "./core-work-items.service.js";
import { CoreNotificationsApplicationService } from "./core-notifications-application.service.js";
import { CoreAiPendingActionsApplicationService } from "./core-ai-pending-actions-application.service.js";
import { CoreBusinessApplicationService } from "./core-business-application.service.js";
import { CoreVoiceCommandsApplicationService } from "./core-voice-commands-application.service.js";
import { CoreSearchService } from "./core-search.service.js";
import { CoreV2CustomersService } from "./core-v2-customers.service.js";
import { CoreV2TasksService } from "./core-v2-tasks.service.js";

export const CORE_SERVICE = Symbol("CORE_SERVICE");

type RouteMethod = "get" | "post" | "patch" | "delete";
type Delegate<T> = (core: T, request: FastifyRequest) => unknown;

type RouteDefinition<T> = {
  name: string;
  method: RouteMethod;
  path: string;
  delegate: Delegate<T>;
};

type CoreControllerType<T> = Type<{ core: T }>;

function headers(request: FastifyRequest) {
  return request.headers;
}

function params(request: FastifyRequest) {
  return request.params as Record<string, string>;
}

function routeDecorator(method: RouteMethod) {
  return { get: Get, post: Post, patch: Patch, delete: Delete }[method];
}

function defineRoutes<T>(controller: CoreControllerType<T>, routes: RouteDefinition<T>[]) {
  for (const route of routes) {
    Object.defineProperty(controller.prototype, route.name, {
      configurable: true,
      value(this: { core: T }, request: FastifyRequest) {
        return route.delegate(this.core, request);
      }
    });
    const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, route.name);
    if (!descriptor) {
      throw new Error(`Route handler was not defined: ${route.name}`);
    }
    routeDecorator(route.method)(route.path)(controller.prototype, route.name, descriptor);
    Req()(controller.prototype, route.name, 0);
  }
}

@Controller()
export class SystemController {
  constructor(@Inject(CoreBusinessApplicationService) readonly core: CoreBusinessApplicationService) {}
}

defineRoutes(SystemController, [
  { name: "health", method: "get", path: "health", delegate: (core) => core.health() },
  { name: "registerBusiness", method: "post", path: "auth/register-business", delegate: (core, request) => core.registerBusiness(headers(request), request.body) },
  { name: "me", method: "get", path: "auth/me", delegate: (core, request) => core.me(headers(request)) },
  { name: "getSettings", method: "get", path: "businesses/:businessId/settings", delegate: (core, request) => core.getSettings(headers(request), params(request).businessId) },
  { name: "updateSettings", method: "patch", path: "businesses/:businessId/settings", delegate: (core, request) => core.updateSettings(headers(request), params(request).businessId, request.body) },
  { name: "listMembers", method: "get", path: "businesses/:businessId/members", delegate: (core, request) => core.listMembers(headers(request), params(request).businessId) },
  { name: "createMember", method: "post", path: "businesses/:businessId/members", delegate: (core, request) => core.createMember(headers(request), params(request).businessId, request.body) },
  { name: "disableMember", method: "post", path: "businesses/:businessId/members/:memberId/disable", delegate: (core, request) => core.disableMember(headers(request), params(request).businessId, params(request).memberId) },
  { name: "listPhoneNumbers", method: "get", path: "businesses/:businessId/phone-numbers", delegate: (core, request) => core.listPhoneNumbers(headers(request), params(request).businessId) },
  { name: "createPhoneNumber", method: "post", path: "businesses/:businessId/phone-numbers", delegate: (core, request) => core.createPhoneNumber(headers(request), params(request).businessId, request.body) },
  { name: "updatePhoneNumber", method: "patch", path: "businesses/:businessId/phone-numbers/:phoneNumberId", delegate: (core, request) => core.updatePhoneNumber(headers(request), params(request).businessId, params(request).phoneNumberId, request.body) }
]);

@Controller()
export class InternalController {
  constructor(@Inject(CORE_SERVICE) readonly core: CoreService) {}
}

defineRoutes(InternalController, [
  { name: "createIncomingCall", method: "post", path: "internal/telephony/incoming", delegate: (core, request) => core.createIncomingCall(headers(request), request.body) },
  { name: "createCallTranscript", method: "post", path: "internal/telephony/recording", delegate: (core, request) => core.createCallTranscript(headers(request), request.body) },
  { name: "createReminderFromCall", method: "post", path: "internal/reminders/from-call", delegate: (core, request) => core.createReminderFromCall(headers(request), request.body) },
  { name: "processDueReminders", method: "post", path: "internal/reminders/due", delegate: (core, request) => core.processDueReminders(headers(request), request.body) },
  { name: "executeOwnerAction", method: "post", path: "owner-actions/execute", delegate: (core, request) => core.executeOwnerAction(headers(request), request.body) }
]);

@Controller()
export class VoiceCommandsController {
  constructor(@Inject(CoreVoiceCommandsApplicationService) readonly core: CoreVoiceCommandsApplicationService) {}
}

defineRoutes(VoiceCommandsController, [
  { name: "listOwnerVoiceCommands", method: "get", path: "businesses/:businessId/voice-commands", delegate: (core, request) => core.listOwnerVoiceCommands(headers(request), params(request).businessId, request.query) },
  { name: "createOwnerVoiceRealtimeSession", method: "post", path: "businesses/:businessId/voice-commands/realtime-session", delegate: (core, request) => core.createOwnerVoiceRealtimeSession(headers(request), params(request).businessId) },
  { name: "createOwnerVoiceCommandFromTranscript", method: "post", path: "businesses/:businessId/voice-commands/transcript", delegate: (core, request) => core.createOwnerVoiceCommandFromTranscript(headers(request), params(request).businessId, request.body) },
  { name: "createOwnerVoiceCommandFromAudio", method: "post", path: "businesses/:businessId/voice-commands/audio", delegate: (core, request) => core.createOwnerVoiceCommandFromAudio(headers(request), params(request).businessId, request.body) }
]);

@Controller()
export class CustomersController {
  constructor(@Inject(CoreCustomersService) readonly core: CoreCustomersService) {}
}

@Controller()
export class SearchController {
  constructor(@Inject(CoreSearchService) readonly core: CoreSearchService) {}
}

defineRoutes(SearchController, [
  { name: "searchBusiness", method: "get", path: "businesses/:businessId/search", delegate: (core, request) => core.search(headers(request), params(request).businessId, request.query) }
]);

defineRoutes(CustomersController, [
  { name: "createCustomer", method: "post", path: "businesses/:businessId/customers", delegate: (core, request) => core.createCustomer(headers(request), params(request).businessId, request.body) },
  { name: "listCustomers", method: "get", path: "businesses/:businessId/customers", delegate: (core, request) => core.listCustomers(headers(request), params(request).businessId, request.query) },
  { name: "getCustomer", method: "get", path: "businesses/:businessId/customers/:customerId", delegate: (core, request) => core.getCustomer(headers(request), params(request).businessId, params(request).customerId) },
  { name: "updateCustomer", method: "patch", path: "businesses/:businessId/customers/:customerId", delegate: (core, request) => core.updateCustomer(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "deleteCustomer", method: "delete", path: "businesses/:businessId/customers/:customerId", delegate: (core, request) => core.deleteCustomer(headers(request), params(request).businessId, params(request).customerId) },
  { name: "mergeCustomer", method: "post", path: "businesses/:businessId/customers/:customerId/merge", delegate: (core, request) => core.mergeCustomer(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "createNote", method: "post", path: "businesses/:businessId/customers/:customerId/notes", delegate: (core, request) => core.createNote(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "updateNote", method: "patch", path: "businesses/:businessId/customers/:customerId/notes/:noteId", delegate: (core, request) => core.updateNote(headers(request), params(request).businessId, params(request).customerId, params(request).noteId, request.body) },
  { name: "deleteNote", method: "delete", path: "businesses/:businessId/customers/:customerId/notes/:noteId", delegate: (core, request) => core.deleteNote(headers(request), params(request).businessId, params(request).customerId, params(request).noteId) },
  { name: "listNotes", method: "get", path: "businesses/:businessId/customers/:customerId/notes", delegate: (core, request) => core.listNotes(headers(request), params(request).businessId, params(request).customerId) },
  { name: "listIncomingCalls", method: "get", path: "businesses/:businessId/calls", delegate: (core, request) => core.listIncomingCalls(headers(request), params(request).businessId, request.query) }
]);

@Controller()
export class V2CustomersController {
  constructor(@Inject(CoreV2CustomersService) readonly core: CoreV2CustomersService) {}
}

defineRoutes(V2CustomersController, [
  { name: "createCustomer", method: "post", path: "v2/businesses/:businessId/customers", delegate: (core, request) => core.createCustomer(headers(request), params(request).businessId, request.body) },
  { name: "listCustomers", method: "get", path: "v2/businesses/:businessId/customers", delegate: (core, request) => core.listCustomers(headers(request), params(request).businessId, request.query) },
  { name: "getCustomer", method: "get", path: "v2/businesses/:businessId/customers/:customerId", delegate: (core, request) => core.getCustomer(headers(request), params(request).businessId, params(request).customerId) },
  { name: "updateCustomer", method: "patch", path: "v2/businesses/:businessId/customers/:customerId", delegate: (core, request) => core.updateCustomer(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "createPhone", method: "post", path: "v2/businesses/:businessId/customers/:customerId/phones", delegate: (core, request) => core.createPhone(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "updatePhone", method: "patch", path: "v2/businesses/:businessId/customers/:customerId/phones/:phoneId", delegate: (core, request) => core.updatePhone(headers(request), params(request).businessId, params(request).customerId, params(request).phoneId, request.body) },
  { name: "deletePhone", method: "delete", path: "v2/businesses/:businessId/customers/:customerId/phones/:phoneId", delegate: (core, request) => core.deletePhone(headers(request), params(request).businessId, params(request).customerId, params(request).phoneId) },
  { name: "createAddress", method: "post", path: "v2/businesses/:businessId/customers/:customerId/addresses", delegate: (core, request) => core.createAddress(headers(request), params(request).businessId, params(request).customerId, request.body) },
  { name: "updateAddress", method: "patch", path: "v2/businesses/:businessId/customers/:customerId/addresses/:addressId", delegate: (core, request) => core.updateAddress(headers(request), params(request).businessId, params(request).customerId, params(request).addressId, request.body) },
  { name: "deleteAddress", method: "delete", path: "v2/businesses/:businessId/customers/:customerId/addresses/:addressId", delegate: (core, request) => core.deleteAddress(headers(request), params(request).businessId, params(request).customerId, params(request).addressId) }
]);

@Controller()
export class V2TasksController {
  constructor(@Inject(CoreV2TasksService) readonly core: CoreV2TasksService) {}
}

defineRoutes(V2TasksController, [
  { name: "createTask", method: "post", path: "v2/businesses/:businessId/tasks", delegate: (core, request) => core.createTask(headers(request), params(request).businessId, request.body) },
  { name: "listTasks", method: "get", path: "v2/businesses/:businessId/tasks", delegate: (core, request) => core.listTasks(headers(request), params(request).businessId, request.query) },
  { name: "getTask", method: "get", path: "v2/businesses/:businessId/tasks/:taskId", delegate: (core, request) => core.getTask(headers(request), params(request).businessId, params(request).taskId) },
  { name: "updateTask", method: "patch", path: "v2/businesses/:businessId/tasks/:taskId", delegate: (core, request) => core.updateTask(headers(request), params(request).businessId, params(request).taskId, request.body) },
  { name: "deleteTask", method: "delete", path: "v2/businesses/:businessId/tasks/:taskId", delegate: (core, request) => core.deleteTask(headers(request), params(request).businessId, params(request).taskId) },
  { name: "completeTask", method: "post", path: "v2/businesses/:businessId/tasks/:taskId/complete", delegate: (core, request) => core.completeTask(headers(request), params(request).businessId, params(request).taskId) },
  { name: "cancelTask", method: "post", path: "v2/businesses/:businessId/tasks/:taskId/cancel", delegate: (core, request) => core.cancelTask(headers(request), params(request).businessId, params(request).taskId) },
  { name: "reopenTask", method: "post", path: "v2/businesses/:businessId/tasks/:taskId/reopen", delegate: (core, request) => core.reopenTask(headers(request), params(request).businessId, params(request).taskId) }
]);

@Controller()
export class WorkItemsController {
  constructor(@Inject(CoreWorkItemsService) readonly core: CoreWorkItemsService) {}
}

defineRoutes(WorkItemsController, [
  { name: "getHome", method: "get", path: "businesses/:businessId/home", delegate: (core, request) => core.getHome(headers(request), params(request).businessId, request.query) },
  { name: "getWorkItem", method: "get", path: "businesses/:businessId/work-items/:itemType/:itemId", delegate: (core, request) => core.getWorkItem(headers(request), params(request).businessId, params(request).itemType, params(request).itemId) },
  { name: "listReminders", method: "get", path: "businesses/:businessId/reminders", delegate: (core, request) => core.listReminders(headers(request), params(request).businessId, request.query) },
  { name: "createReminder", method: "post", path: "businesses/:businessId/reminders", delegate: (core, request) => core.createReminder(headers(request), params(request).businessId, request.body) },
  { name: "updateReminder", method: "patch", path: "businesses/:businessId/reminders/:reminderId", delegate: (core, request) => core.updateReminder(headers(request), params(request).businessId, params(request).reminderId, request.body) },
  { name: "completeReminder", method: "post", path: "businesses/:businessId/reminders/:reminderId/complete", delegate: (core, request) => core.completeReminder(headers(request), params(request).businessId, params(request).reminderId) },
  { name: "deleteReminder", method: "delete", path: "businesses/:businessId/reminders/:reminderId", delegate: (core, request) => core.deleteReminder(headers(request), params(request).businessId, params(request).reminderId) },
  { name: "listAppointments", method: "get", path: "businesses/:businessId/appointments", delegate: (core, request) => core.listAppointments(headers(request), params(request).businessId, request.query) },
  { name: "createAppointment", method: "post", path: "businesses/:businessId/appointments", delegate: (core, request) => core.createAppointment(headers(request), params(request).businessId, request.body) },
  { name: "updateAppointment", method: "patch", path: "businesses/:businessId/appointments/:appointmentId", delegate: (core, request) => core.updateAppointment(headers(request), params(request).businessId, params(request).appointmentId, request.body) },
  { name: "deleteAppointment", method: "delete", path: "businesses/:businessId/appointments/:appointmentId", delegate: (core, request) => core.deleteAppointment(headers(request), params(request).businessId, params(request).appointmentId) },
  { name: "cancelAppointment", method: "post", path: "businesses/:businessId/appointments/:appointmentId/cancel", delegate: (core, request) => core.cancelAppointment(headers(request), params(request).businessId, params(request).appointmentId) },
  { name: "completeAppointment", method: "post", path: "businesses/:businessId/appointments/:appointmentId/complete", delegate: (core, request) => core.completeAppointment(headers(request), params(request).businessId, params(request).appointmentId) },
  { name: "listHomeVisits", method: "get", path: "businesses/:businessId/home-visits", delegate: (core, request) => core.listHomeVisits(headers(request), params(request).businessId, request.query) },
  { name: "createHomeVisit", method: "post", path: "businesses/:businessId/home-visits", delegate: (core, request) => core.createHomeVisit(headers(request), params(request).businessId, request.body) },
  { name: "updateHomeVisit", method: "patch", path: "businesses/:businessId/home-visits/:homeVisitId", delegate: (core, request) => core.updateHomeVisit(headers(request), params(request).businessId, params(request).homeVisitId, request.body) },
  { name: "completeHomeVisit", method: "post", path: "businesses/:businessId/home-visits/:homeVisitId/complete", delegate: (core, request) => core.completeHomeVisit(headers(request), params(request).businessId, params(request).homeVisitId) },
  { name: "deleteHomeVisit", method: "delete", path: "businesses/:businessId/home-visits/:homeVisitId", delegate: (core, request) => core.deleteHomeVisit(headers(request), params(request).businessId, params(request).homeVisitId) },
  { name: "listQuotes", method: "get", path: "businesses/:businessId/quotes", delegate: (core, request) => core.listQuotes(headers(request), params(request).businessId, request.query) },
  { name: "createQuote", method: "post", path: "businesses/:businessId/quotes", delegate: (core, request) => core.createQuote(headers(request), params(request).businessId, request.body) },
  { name: "updateQuote", method: "patch", path: "businesses/:businessId/quotes/:quoteId", delegate: (core, request) => core.updateQuote(headers(request), params(request).businessId, params(request).quoteId, request.body) },
  { name: "markQuotePaid", method: "post", path: "businesses/:businessId/quotes/:quoteId/mark-paid", delegate: (core, request) => core.markQuotePaid(headers(request), params(request).businessId, params(request).quoteId) },
  { name: "deleteQuote", method: "delete", path: "businesses/:businessId/quotes/:quoteId", delegate: (core, request) => core.deleteQuote(headers(request), params(request).businessId, params(request).quoteId) }
]);

@Controller()
export class NotificationsController {
  constructor(@Inject(CoreNotificationsApplicationService) readonly core: CoreNotificationsApplicationService) {}
}

defineRoutes(NotificationsController, [
  { name: "listNotifications", method: "get", path: "businesses/:businessId/notifications", delegate: (core, request) => core.listNotifications(headers(request), params(request).businessId, request.query) },
  { name: "registerDeviceToken", method: "post", path: "businesses/:businessId/device-tokens", delegate: (core, request) => core.registerDeviceToken(headers(request), params(request).businessId, request.body) },
  { name: "updateNotification", method: "patch", path: "businesses/:businessId/notifications/:notificationId", delegate: (core, request) => core.updateNotification(headers(request), params(request).businessId, params(request).notificationId, request.body) },
  { name: "markNotificationRead", method: "post", path: "businesses/:businessId/notifications/:notificationId/read", delegate: (core, request) => core.markNotificationRead(headers(request), params(request).businessId, params(request).notificationId) },
  { name: "markAllNotificationsRead", method: "post", path: "businesses/:businessId/notifications/read-all", delegate: (core, request) => core.markAllNotificationsRead(headers(request), params(request).businessId) },
  { name: "snoozeNotification", method: "post", path: "businesses/:businessId/notifications/:notificationId/snooze", delegate: (core, request) => core.snoozeNotification(headers(request), params(request).businessId, params(request).notificationId, request.body) }
]);

@Controller()
export class AiActionsController {
  constructor(@Inject(CoreAiPendingActionsApplicationService) readonly core: CoreAiPendingActionsApplicationService) {}
}

defineRoutes(AiActionsController, [
  { name: "listAiPendingActions", method: "get", path: "businesses/:businessId/ai-pending-actions", delegate: (core, request) => core.listAiPendingActions(headers(request), params(request).businessId, request.query) },
  { name: "updateAiPendingAction", method: "patch", path: "businesses/:businessId/ai-pending-actions/:aiPendingActionId", delegate: (core, request) => core.updateAiPendingAction(headers(request), params(request).businessId, params(request).aiPendingActionId, request.body) },
  { name: "rejectAiPendingAction", method: "post", path: "businesses/:businessId/ai-pending-actions/:aiPendingActionId/reject", delegate: (core, request) => core.rejectAiPendingAction(headers(request), params(request).businessId, params(request).aiPendingActionId) },
  { name: "approveAiPendingAction", method: "post", path: "businesses/:businessId/ai-pending-actions/:aiPendingActionId/approve", delegate: (core, request) => core.approveAiPendingAction(headers(request), params(request).businessId, params(request).aiPendingActionId, request.body) },
  { name: "listAuditEvents", method: "get", path: "businesses/:businessId/audit-events", delegate: (core, request) => core.listAuditEvents(headers(request), params(request).businessId, request.query) }
]);
