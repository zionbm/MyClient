import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getEnv, log } from "@myclient/common";
import { DeviceTokensRepository, NotificationsRepository } from "./core.repositories.js";

function firebaseApp() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
}

function notificationPayloadData(payload: Prisma.JsonValue | null | undefined, notificationId: string) {
  const data: Record<string, string> = { notificationId };
  if (payload !== undefined && payload !== null) {
    data.payload = JSON.stringify(payload);
  }
  return data;
}

@Injectable()
export class CoreNotificationsService {
  constructor(
    @Inject(NotificationsRepository) private readonly notifications: NotificationsRepository,
    @Inject(DeviceTokensRepository) private readonly deviceTokens: DeviceTokensRepository
  ) {}

  async sendNotification(notification: {
    id: string;
    businessId: string;
    title: string;
    body: string;
    payload: Prisma.JsonValue | null;
  }) {
    if (getEnv("MOCK_FCM_PROVIDER", "true") === "true") {
      const sent = await this.notifications.updateStatus({
        businessId: notification.businessId,
        notificationId: notification.id,
        status: "SENT"
      });
      return { provider: "mock-fcm", status: "SENT", notification: sent ?? notification };
    }

    const tokens = await this.deviceTokens.listActiveByBusiness(notification.businessId);
    if (tokens.length === 0) {
      log("warn", "notification delivery skipped without active device tokens", {
        businessId: notification.businessId,
        notificationId: notification.id
      });
      const failed = await this.notifications.updateStatus({
        businessId: notification.businessId,
        notificationId: notification.id,
        status: "FAILED",
        failureReason: "No active FCM device tokens"
      });
      return { provider: "firebase-fcm", status: "FAILED", notification: failed ?? notification };
    }

    firebaseApp();
    const response = await getMessaging().sendEachForMulticast({
      tokens: tokens.map((deviceToken) => deviceToken.token),
      android: { priority: "high", notification: { channelId: "reminder_reminders" } },
      notification: { title: notification.title, body: notification.body },
      data: notificationPayloadData(notification.payload, notification.id)
    });

    log("info", "firebase notification delivery finished", {
      businessId: notification.businessId,
      notificationId: notification.id,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      errors: response.responses
        .filter((result) => !result.success)
        .map((result) => result.error?.code ?? result.error?.message ?? "unknown")
    });

    await Promise.all(response.responses.map((result, index) =>
      result.success ? Promise.resolve() : this.deviceTokens.deactivate(tokens[index].token)
    ));

    const sent = await this.notifications.updateStatus({
      businessId: notification.businessId,
      notificationId: notification.id,
      status: response.successCount > 0 ? "SENT" : "FAILED",
      failureReason: response.failureCount > 0 ? `${response.failureCount} FCM deliveries failed` : undefined
    });
    return {
      provider: "firebase-fcm",
      status: response.successCount > 0 ? "SENT" : "FAILED",
      successCount: response.successCount,
      failureCount: response.failureCount,
      notification: sent ?? notification
    };
  }
}
