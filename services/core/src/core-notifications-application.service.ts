import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  NotificationListQuerySchema,
  RegisterDeviceTokenSchema,
  SnoozeNotificationSchema,
  UpdateNotificationSchema
} from "@myclient/contracts";
import {
  AuditRepository,
  BusinessSettingsRepository,
  DeviceTokensRepository,
  NotificationsRepository,
  TasksRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import {
  paginatedResponse,
  paginationFromParsedQuery,
  publicDeviceToken,
  snoozeDueAt,
  type RequestHeaders
} from "./core-utils.js";

@Injectable()
export class CoreNotificationsApplicationService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(DeviceTokensRepository) private readonly deviceTokens: DeviceTokensRepository,
    @Inject(TasksRepository) private readonly tasks: TasksRepository
  ) {}
  async listNotifications(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = NotificationListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const page = paginatedResponse(
      await this.notifications.listByBusinessAndStatus(businessId, command.status, pagination),
      pagination.limit
    );
    return { notifications: page.items, pageInfo: page.pageInfo };
  }
  async registerDeviceToken(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = RegisterDeviceTokenSchema.parse(body);
    const deviceToken = await this.deviceTokens.register({
      businessId,
      userId: user.id,
      token: command.token,
      platform: command.platform,
      appVersion: command.appVersion
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "device_token",
      entityId: deviceToken.id,
      action: "REGISTER_DEVICE_TOKEN",
      after: {
        id: deviceToken.id,
        platform: deviceToken.platform,
        appVersion: deviceToken.appVersion,
        status: deviceToken.status,
        lastSeenAt: deviceToken.lastSeenAt
      } as Prisma.InputJsonValue
    });
    return { deviceToken: publicDeviceToken(deviceToken) };
  }
  async updateNotification(headers: RequestHeaders, businessId: string, notificationId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateNotificationSchema.parse(body);
    const notification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: command.status,
      failureReason: command.failureReason
    });
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      entityId: notification.id,
      action: `MARK_NOTIFICATION_${command.status}`,
      after: notification as Prisma.InputJsonValue
    });
    return { notification };
  }
  async markNotificationRead(headers: RequestHeaders, businessId: string, notificationId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const notification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: "READ"
    });
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      entityId: notification.id,
      action: "MARK_NOTIFICATION_READ",
      after: notification as Prisma.InputJsonValue
    });
    return { notification };
  }
  async markAllNotificationsRead(headers: RequestHeaders, businessId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const result = await this.notifications.markAllRead(businessId);
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      action: "MARK_ALL_NOTIFICATIONS_READ",
      after: result as Prisma.InputJsonValue
    });
    return { updatedCount: result.count };
  }
  async snoozeNotification(headers: RequestHeaders, businessId: string, notificationId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = SnoozeNotificationSchema.parse(body);
    const notification = await this.notifications.findByBusinessAndId(businessId, notificationId);
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    const settings = await this.settings.getByBusiness(businessId);
    const dueAt = snoozeDueAt(command.preset, settings.timezone);
    if (notification.itemType !== "task" || !notification.itemId) {
      throw new BadRequestException("Notification is not linked to a snoozable item");
    }
    const item = await this.tasks.update({ businessId, taskId: notification.itemId, dueAt });
    if (!item) {
      throw new NotFoundException("Snoozable item not found");
    }
    const readNotification = await this.notifications.updateStatus({
      businessId,
      notificationId,
      status: "READ"
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "notification",
      entityId: notification.id,
      action: "SNOOZE_NOTIFICATION",
      after: { notification: readNotification, item, dueAt: dueAt.toISOString() } as Prisma.InputJsonValue
    });
    return { notification: readNotification, item, dueAt };
  }
}
