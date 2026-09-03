import { Controller, Delete, Get, Inject, Patch, Post, Put, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { CoreService } from "./main.js";
import { CoreNotificationsApplicationService } from "./core-notifications-application.service.js";
import { CoreBusinessApplicationService } from "./core-business-application.service.js";
import { CoreCallsService } from "./core-calls.service.js";
import { CoreV2CustomersService } from "./core-v2-customers.service.js";
import { CoreV2TasksService } from "./core-v2-tasks.service.js";
import { CoreV2AssistantService } from "./core-v2-assistant.service.js";
import { CoreV2ActivitiesService } from "./core-v2-activities.service.js";
import { CoreV2SearchService } from "./core-v2-search.service.js";
import { CoreV2AmountsService } from "./core-v2-amounts.service.js";
import { CoreV2ActionBatchesService } from "./core-v2-action-batches.service.js";
import { CoreV2NotesService } from "./core-v2-notes.service.js";

export const CORE_SERVICE = Symbol("CORE_SERVICE");

function headers(request: FastifyRequest) {
  return request.headers;
}

function params(request: FastifyRequest) {
  return request.params as Record<string, string>;
}

@Controller()
export class SystemController {
  constructor(@Inject(CoreBusinessApplicationService) private readonly core: CoreBusinessApplicationService) {}

  @Get("health")
  health() {
    return this.core.health();
  }

  @Post("auth/register-business")
  registerBusiness(@Req() request: FastifyRequest) {
    return this.core.registerBusiness(headers(request), request.body);
  }

  @Get("auth/me")
  me(@Req() request: FastifyRequest) {
    return this.core.me(headers(request));
  }

  @Get("businesses/:businessId/settings")
  getSettings(@Req() request: FastifyRequest) {
    return this.core.getSettings(headers(request), params(request).businessId);
  }

  @Patch("businesses/:businessId/settings")
  updateSettings(@Req() request: FastifyRequest) {
    return this.core.updateSettings(headers(request), params(request).businessId, request.body);
  }

  @Get("businesses/:businessId/members")
  listMembers(@Req() request: FastifyRequest) {
    return this.core.listMembers(headers(request), params(request).businessId);
  }

  @Post("businesses/:businessId/members")
  createMember(@Req() request: FastifyRequest) {
    return this.core.createMember(headers(request), params(request).businessId, request.body);
  }

  @Post("businesses/:businessId/members/:memberId/disable")
  disableMember(@Req() request: FastifyRequest) {
    return this.core.disableMember(headers(request), params(request).businessId, params(request).memberId);
  }

  @Get("businesses/:businessId/phone-numbers")
  listPhoneNumbers(@Req() request: FastifyRequest) {
    return this.core.listPhoneNumbers(headers(request), params(request).businessId);
  }

  @Post("businesses/:businessId/phone-numbers")
  createPhoneNumber(@Req() request: FastifyRequest) {
    return this.core.createPhoneNumber(headers(request), params(request).businessId, request.body);
  }

  @Patch("businesses/:businessId/phone-numbers/:phoneNumberId")
  updatePhoneNumber(@Req() request: FastifyRequest) {
    return this.core.updatePhoneNumber(
      headers(request),
      params(request).businessId,
      params(request).phoneNumberId,
      request.body
    );
  }
}

@Controller()
export class InternalController {
  constructor(@Inject(CORE_SERVICE) private readonly core: CoreService) {}

  @Post("internal/telephony/incoming")
  createIncomingCall(@Req() request: FastifyRequest) {
    return this.core.createIncomingCall(headers(request), request.body);
  }

  @Post("internal/telephony/recording")
  createCallTranscript(@Req() request: FastifyRequest) {
    return this.core.createCallTranscript(headers(request), request.body);
  }

  @Post("internal/tasks/from-call")
  createTaskFromCall(@Req() request: FastifyRequest) {
    return this.core.createTaskFromCall(headers(request), request.body);
  }

  @Post("internal/tasks/due")
  processDueTasks(@Req() request: FastifyRequest) {
    return this.core.processDueTasks(headers(request), request.body);
  }
}

@Controller()
export class CallsController {
  constructor(@Inject(CoreCallsService) private readonly core: CoreCallsService) {}

  @Get("v2/businesses/:businessId/calls")
  list(@Req() request: FastifyRequest) {
    return this.core.list(headers(request), params(request).businessId, request.query);
  }
}

@Controller()
export class V2CustomersController {
  constructor(@Inject(CoreV2CustomersService) private readonly core: CoreV2CustomersService) {}

  @Post("v2/businesses/:businessId/customers")
  createCustomer(@Req() request: FastifyRequest) {
    return this.core.createCustomer(headers(request), params(request).businessId, request.body);
  }
  @Get("v2/businesses/:businessId/customers")
  listCustomers(@Req() request: FastifyRequest) {
    return this.core.listCustomers(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/customers/:customerId")
  getCustomer(@Req() request: FastifyRequest) {
    return this.core.getCustomer(headers(request), params(request).businessId, params(request).customerId);
  }
  @Patch("v2/businesses/:businessId/customers/:customerId")
  updateCustomer(@Req() request: FastifyRequest) {
    return this.core.updateCustomer(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Delete("v2/businesses/:businessId/customers/:customerId")
  deleteCustomer(@Req() request: FastifyRequest) {
    return this.core.deleteCustomer(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/customers/:customerId/restore")
  restoreCustomer(@Req() request: FastifyRequest) {
    return this.core.restoreCustomer(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/customers/:customerId/merge")
  mergeCustomer(@Req() request: FastifyRequest) {
    return this.core.mergeCustomer(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/customers/:customerId/phones")
  createPhone(@Req() request: FastifyRequest) {
    return this.core.createPhone(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Patch("v2/businesses/:businessId/customers/:customerId/phones/:phoneId")
  updatePhone(@Req() request: FastifyRequest) {
    return this.core.updatePhone(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).phoneId,
      request.body
    );
  }
  @Delete("v2/businesses/:businessId/customers/:customerId/phones/:phoneId")
  deletePhone(@Req() request: FastifyRequest) {
    return this.core.deletePhone(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).phoneId
    );
  }
  @Post("v2/businesses/:businessId/customers/:customerId/addresses")
  createAddress(@Req() request: FastifyRequest) {
    return this.core.createAddress(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      request.body
    );
  }
  @Patch("v2/businesses/:businessId/customers/:customerId/addresses/:addressId")
  updateAddress(@Req() request: FastifyRequest) {
    return this.core.updateAddress(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).addressId,
      request.body
    );
  }
  @Delete("v2/businesses/:businessId/customers/:customerId/addresses/:addressId")
  deleteAddress(@Req() request: FastifyRequest) {
    return this.core.deleteAddress(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).addressId
    );
  }
}

@Controller()
export class V2NotesController {
  constructor(@Inject(CoreV2NotesService) private readonly core: CoreV2NotesService) {}

  @Post("v2/businesses/:businessId/customers/:customerId/notes")
  createNote(@Req() request: FastifyRequest) {
    return this.core.create(headers(request), params(request).businessId, params(request).customerId, request.body);
  }
  @Patch("v2/businesses/:businessId/customers/:customerId/notes/:noteId")
  updateNote(@Req() request: FastifyRequest) {
    return this.core.update(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).noteId,
      request.body
    );
  }
  @Delete("v2/businesses/:businessId/customers/:customerId/notes/:noteId")
  deleteNote(@Req() request: FastifyRequest) {
    return this.core.delete(
      headers(request),
      params(request).businessId,
      params(request).customerId,
      params(request).noteId
    );
  }
}

@Controller()
export class V2TasksController {
  constructor(@Inject(CoreV2TasksService) private readonly core: CoreV2TasksService) {}

  @Post("v2/businesses/:businessId/tasks")
  createTask(@Req() request: FastifyRequest) {
    return this.core.createTask(headers(request), params(request).businessId, request.body);
  }
  @Get("v2/businesses/:businessId/tasks")
  listTasks(@Req() request: FastifyRequest) {
    return this.core.listTasks(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/tasks/:taskId")
  getTask(@Req() request: FastifyRequest) {
    return this.core.getTask(headers(request), params(request).businessId, params(request).taskId);
  }
  @Patch("v2/businesses/:businessId/tasks/:taskId")
  updateTask(@Req() request: FastifyRequest) {
    return this.core.updateTask(headers(request), params(request).businessId, params(request).taskId, request.body);
  }
  @Delete("v2/businesses/:businessId/tasks/:taskId")
  deleteTask(@Req() request: FastifyRequest) {
    return this.core.deleteTask(headers(request), params(request).businessId, params(request).taskId);
  }
  @Post("v2/businesses/:businessId/tasks/:taskId/complete")
  completeTask(@Req() request: FastifyRequest) {
    return this.core.completeTask(headers(request), params(request).businessId, params(request).taskId);
  }
  @Post("v2/businesses/:businessId/tasks/:taskId/cancel")
  cancelTask(@Req() request: FastifyRequest) {
    return this.core.cancelTask(headers(request), params(request).businessId, params(request).taskId);
  }
  @Post("v2/businesses/:businessId/tasks/:taskId/reopen")
  reopenTask(@Req() request: FastifyRequest) {
    return this.core.reopenTask(headers(request), params(request).businessId, params(request).taskId);
  }
}

@Controller()
export class V2AssistantController {
  constructor(@Inject(CoreV2AssistantService) private readonly core: CoreV2AssistantService) {}

  @Post("v2/businesses/:businessId/assistant/realtime-session")
  createRealtimeSession(@Req() request: FastifyRequest) {
    return this.core.createRealtimeSession(headers(request), params(request).businessId);
  }
  @Post("v2/businesses/:businessId/assistant/sessions")
  createSession(@Req() request: FastifyRequest) {
    return this.core.createSession(headers(request), params(request).businessId, request.body);
  }
  @Post("v2/businesses/:businessId/assistant/sessions/:sessionId/commands")
  command(@Req() request: FastifyRequest) {
    return this.core.command(headers(request), params(request).businessId, params(request).sessionId, request.body);
  }
  @Get("v2/businesses/:businessId/assistant/pending-actions")
  listPending(@Req() request: FastifyRequest) {
    return this.core.listPending(headers(request), params(request).businessId, request.query);
  }
  @Patch("v2/businesses/:businessId/assistant/pending-actions/:pendingActionId")
  updatePending(@Req() request: FastifyRequest) {
    return this.core.updatePending(
      headers(request),
      params(request).businessId,
      params(request).pendingActionId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/assistant/pending-actions/:pendingActionId/resolve")
  resolvePending(@Req() request: FastifyRequest) {
    return this.core.resolvePending(
      headers(request),
      params(request).businessId,
      params(request).pendingActionId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/assistant/pending-actions/:pendingActionId/reject")
  rejectPending(@Req() request: FastifyRequest) {
    return this.core.rejectPending(headers(request), params(request).businessId, params(request).pendingActionId);
  }
}

@Controller()
export class V2ActivitiesController {
  constructor(@Inject(CoreV2ActivitiesService) private readonly core: CoreV2ActivitiesService) {}

  @Get("v2/businesses/:businessId/jobs")
  listJobs(@Req() request: FastifyRequest) {
    return this.core.list("job", headers(request), params(request).businessId, request.query);
  }
  @Post("v2/businesses/:businessId/jobs")
  createJob(@Req() request: FastifyRequest) {
    return this.core.createJob(headers(request), params(request).businessId, request.body);
  }
  @Get("v2/businesses/:businessId/jobs/:jobId")
  getJob(@Req() request: FastifyRequest) {
    return this.core.get("job", headers(request), params(request).businessId, params(request).jobId);
  }
  @Patch("v2/businesses/:businessId/jobs/:jobId")
  updateJob(@Req() request: FastifyRequest) {
    return this.core.update("job", headers(request), params(request).businessId, params(request).jobId, request.body);
  }
  @Delete("v2/businesses/:businessId/jobs/:jobId")
  deleteJob(@Req() request: FastifyRequest) {
    return this.core.delete("job", headers(request), params(request).businessId, params(request).jobId);
  }
  @Post("v2/businesses/:businessId/jobs/:jobId/report-completed")
  reportJobCompleted(@Req() request: FastifyRequest) {
    return this.core.reportCompleted(
      "job",
      headers(request),
      params(request).businessId,
      params(request).jobId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/jobs/:jobId/cancel")
  cancelJob(@Req() request: FastifyRequest) {
    return this.core.cancel("job", headers(request), params(request).businessId, params(request).jobId);
  }
  @Post("v2/businesses/:businessId/jobs/:jobId/reopen")
  reopenJob(@Req() request: FastifyRequest) {
    return this.core.reopen("job", headers(request), params(request).businessId, params(request).jobId);
  }
  @Get("v2/businesses/:businessId/visits")
  listVisits(@Req() request: FastifyRequest) {
    return this.core.list("visit", headers(request), params(request).businessId, request.query);
  }
  @Post("v2/businesses/:businessId/visits")
  createVisit(@Req() request: FastifyRequest) {
    return this.core.createVisit(headers(request), params(request).businessId, request.body);
  }
  @Get("v2/businesses/:businessId/visits/:visitId")
  getVisit(@Req() request: FastifyRequest) {
    return this.core.get("visit", headers(request), params(request).businessId, params(request).visitId);
  }
  @Patch("v2/businesses/:businessId/visits/:visitId")
  updateVisit(@Req() request: FastifyRequest) {
    return this.core.update(
      "visit",
      headers(request),
      params(request).businessId,
      params(request).visitId,
      request.body
    );
  }
  @Delete("v2/businesses/:businessId/visits/:visitId")
  deleteVisit(@Req() request: FastifyRequest) {
    return this.core.delete("visit", headers(request), params(request).businessId, params(request).visitId);
  }
  @Post("v2/businesses/:businessId/visits/:visitId/report-completed")
  reportVisitCompleted(@Req() request: FastifyRequest) {
    return this.core.reportCompleted(
      "visit",
      headers(request),
      params(request).businessId,
      params(request).visitId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/visits/:visitId/cancel")
  cancelVisit(@Req() request: FastifyRequest) {
    return this.core.cancel("visit", headers(request), params(request).businessId, params(request).visitId);
  }
  @Post("v2/businesses/:businessId/visits/:visitId/reopen")
  reopenVisit(@Req() request: FastifyRequest) {
    return this.core.reopen("visit", headers(request), params(request).businessId, params(request).visitId);
  }
  @Get("v2/businesses/:businessId/schedule")
  schedule(@Req() request: FastifyRequest) {
    return this.core.schedule(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/completed")
  completed(@Req() request: FastifyRequest) {
    return this.core.completed(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/availability")
  availability(@Req() request: FastifyRequest) {
    return this.core.availability(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/customers/:customerId/timeline")
  customerTimeline(@Req() request: FastifyRequest) {
    return this.core.customerTimeline(headers(request), params(request).businessId, params(request).customerId);
  }
}

@Controller()
export class V2SearchController {
  constructor(@Inject(CoreV2SearchService) private readonly core: CoreV2SearchService) {}

  @Get("v2/businesses/:businessId/search")
  search(@Req() request: FastifyRequest) {
    return this.core.search(headers(request), params(request).businessId, request.query);
  }
}

@Controller()
export class V2AmountsController {
  constructor(@Inject(CoreV2AmountsService) private readonly core: CoreV2AmountsService) {}

  @Get("v2/businesses/:businessId/jobs/:jobId/amount")
  getJobAmount(@Req() request: FastifyRequest) {
    return this.core.get("job", headers(request), params(request).businessId, params(request).jobId);
  }
  @Put("v2/businesses/:businessId/jobs/:jobId/amount")
  putJobAmount(@Req() request: FastifyRequest) {
    return this.core.put("job", headers(request), params(request).businessId, params(request).jobId, request.body);
  }
  @Patch("v2/businesses/:businessId/jobs/:jobId/amount")
  patchJobAmount(@Req() request: FastifyRequest) {
    return this.core.patch("job", headers(request), params(request).businessId, params(request).jobId, request.body);
  }
  @Post("v2/businesses/:businessId/jobs/:jobId/amount/payments")
  payJobAmount(@Req() request: FastifyRequest) {
    return this.core.payment("job", headers(request), params(request).businessId, params(request).jobId, request.body);
  }
  @Get("v2/businesses/:businessId/visits/:visitId/amount")
  getVisitAmount(@Req() request: FastifyRequest) {
    return this.core.get("visit", headers(request), params(request).businessId, params(request).visitId);
  }
  @Put("v2/businesses/:businessId/visits/:visitId/amount")
  putVisitAmount(@Req() request: FastifyRequest) {
    return this.core.put("visit", headers(request), params(request).businessId, params(request).visitId, request.body);
  }
  @Patch("v2/businesses/:businessId/visits/:visitId/amount")
  patchVisitAmount(@Req() request: FastifyRequest) {
    return this.core.patch(
      "visit",
      headers(request),
      params(request).businessId,
      params(request).visitId,
      request.body
    );
  }
  @Post("v2/businesses/:businessId/visits/:visitId/amount/payments")
  payVisitAmount(@Req() request: FastifyRequest) {
    return this.core.payment(
      "visit",
      headers(request),
      params(request).businessId,
      params(request).visitId,
      request.body
    );
  }
  @Get("v2/businesses/:businessId/reports/payments")
  paymentReport(@Req() request: FastifyRequest) {
    return this.core.paymentReport(headers(request), params(request).businessId, request.query);
  }
  @Get("v2/businesses/:businessId/reports/open-balances")
  openBalances(@Req() request: FastifyRequest) {
    return this.core.openBalances(headers(request), params(request).businessId);
  }
}

@Controller()
export class V2ActionBatchesController {
  constructor(@Inject(CoreV2ActionBatchesService) private readonly core: CoreV2ActionBatchesService) {}

  @Get("v2/businesses/:businessId/action-batches")
  list(@Req() request: FastifyRequest) {
    return this.core.list(headers(request), params(request).businessId);
  }
  @Get("v2/businesses/:businessId/action-batches/:actionBatchId")
  get(@Req() request: FastifyRequest) {
    return this.core.get(headers(request), params(request).businessId, params(request).actionBatchId);
  }
  @Post("v2/businesses/:businessId/action-batches/:actionBatchId/undo-preview")
  undoPreview(@Req() request: FastifyRequest) {
    return this.core.undoPreview(headers(request), params(request).businessId, params(request).actionBatchId);
  }
  @Post("v2/businesses/:businessId/action-batches/:actionBatchId/undo")
  undo(@Req() request: FastifyRequest) {
    return this.core.undo(headers(request), params(request).businessId, params(request).actionBatchId, request.body);
  }
  @Post("v2/businesses/:businessId/action-batches/:actionBatchId/speech")
  speech(@Req() request: FastifyRequest) {
    return this.core.speech(headers(request), params(request).businessId, params(request).actionBatchId);
  }
  @Get("v2/users/me/preferences")
  getPreferences(@Req() request: FastifyRequest) {
    return this.core.getPreferences(headers(request));
  }
  @Patch("v2/users/me/preferences")
  updatePreferences(@Req() request: FastifyRequest) {
    return this.core.updatePreferences(headers(request), request.body);
  }
  @Post("internal/v2/retention")
  retention(@Req() request: FastifyRequest) {
    return this.core.runRetention(headers(request));
  }
}

@Controller()
export class NotificationsController {
  constructor(
    @Inject(CoreNotificationsApplicationService) private readonly core: CoreNotificationsApplicationService
  ) {}

  @Get("businesses/:businessId/notifications")
  listNotifications(@Req() request: FastifyRequest) {
    return this.core.listNotifications(headers(request), params(request).businessId, request.query);
  }
  @Post("businesses/:businessId/device-tokens")
  registerDeviceToken(@Req() request: FastifyRequest) {
    return this.core.registerDeviceToken(headers(request), params(request).businessId, request.body);
  }
  @Patch("businesses/:businessId/notifications/:notificationId")
  updateNotification(@Req() request: FastifyRequest) {
    return this.core.updateNotification(
      headers(request),
      params(request).businessId,
      params(request).notificationId,
      request.body
    );
  }
  @Post("businesses/:businessId/notifications/:notificationId/read")
  markNotificationRead(@Req() request: FastifyRequest) {
    return this.core.markNotificationRead(headers(request), params(request).businessId, params(request).notificationId);
  }
  @Post("businesses/:businessId/notifications/read-all")
  markAllNotificationsRead(@Req() request: FastifyRequest) {
    return this.core.markAllNotificationsRead(headers(request), params(request).businessId);
  }
  @Post("businesses/:businessId/notifications/:notificationId/snooze")
  snoozeNotification(@Req() request: FastifyRequest) {
    return this.core.snoozeNotification(
      headers(request),
      params(request).businessId,
      params(request).notificationId,
      request.body
    );
  }
}
